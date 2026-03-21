import { EventEmitter } from 'events';

export interface IMessage {
  id: string;
  roomId: string;
  username: string;
  userAddress: string;
  message: string;
  profile_image: string;
  timestamp: string;
  messageType: string;
  expiresAt: number;
}

export interface PumpChatClientOptions {
  roomId: string;
  username?: string;
  messageHistoryLimit?: number;
}

export class BrowserPumpChatClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private roomId: string;
  private username: string;
  private messageHistoryLimit: number;
  private isConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private messageHistory: IMessage[] = [];
  
  private ackId = 0;
  private pendingAcks = new Map<number, { event: string; timestamp: number }>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(options: PumpChatClientOptions) {
    super();
    this.roomId = options.roomId;
    this.username = options.username || "anonymous";
    this.messageHistoryLimit = options.messageHistoryLimit || 100;
  }

  public connect() {
    try {
      this.ws = new WebSocket("wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket");

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log("WebSocket Connected");
        this.emit("connected");
      };

      this.ws.onclose = () => {
        console.log("WebSocket Closed");
        this.isConnected = false;
        this.emit("disconnected");
        this.stopPing();
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        this.emit("error", new Error("WebSocket Connection Error"));
      };

      this.ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          this.handleMessage(event.data);
        }
      };

      // Cleanup stale acks periodically
      setInterval(() => this.cleanupStaleAcks(), 10000);
    } catch (err) {
      this.emit("error", err);
    }
  }

  private handleMessage(data: string) {
    const match = data.match(/^(\d+)/);
    const messageType = match ? match[1] : null;

    switch (messageType) {
      case "0":
        this.handleConnect(data);
        break;
      case "40":
        this.handleConnectedAck(data);
        break;
      case "42":
        this.handleEvent(data);
        break;
      case "43":
        this.handleEventWithAck(data);
        break;
      case "430":
      case "431":
      case "432":
      case "433":
      case "434":
      case "435":
      case "436":
      case "437":
      case "438":
      case "439":
        this.handleNumberedAck(data);
        break;
      case "2":
        this.send("3");
        break;
      case "3":
        break;
    }
  }

  private handleConnect(data: string) {
    const jsonData = data.substring(1);
    try {
      const connectData = JSON.parse(jsonData);
      if (connectData.pingInterval) {
        this.startPing(connectData.pingInterval);
      }
    } catch (e) {
      console.error("Error parsing connect data", e);
    }

    this.send(`40{"origin":"https://pump.fun","timestamp":${Date.now()},"token":null}`);
  }

  private handleConnectedAck(data: string) {
    const joinAckId = this.getNextAckId();
    this.pendingAcks.set(joinAckId, { event: "joinRoom", timestamp: Date.now() });
    this.send(`42${joinAckId}["joinRoom",{"roomId":"${this.roomId}","username":"${this.username}"}]`);
  }

  private handleEvent(data: string) {
    try {
      const eventData = JSON.parse(data.substring(2));
      const [eventName, payload] = eventData;

      switch (eventName) {
        case "setCookie":
          this.requestMessageHistory();
          break;
        case "newMessage":
          this.handleNewMessage(payload);
          break;
        case "userLeft":
          this.emit("userLeft", payload);
          break;
      }
    } catch (error) {
      console.error("Error parsing event:", error);
    }
  }

  private handleEventWithAck(data: string) {
    try {
      const ackData = JSON.parse(data.substring(2));
      const eventData = ackData[0];

      if (eventData && eventData.messages) {
        this.messageHistory = eventData.messages;
      } else if (Array.isArray(eventData)) {
        this.messageHistory = eventData;
      } else if (Array.isArray(ackData) && ackData.length > 0) {
        this.messageHistory = ackData[0];
      }
      this.emit("messageHistory", this.messageHistory);
    } catch (error) {
      console.error("Error parsing acknowledgment:", error);
    }
  }

  private handleNumberedAck(data: string) {
    try {
      const match = data.match(/^(\d+)/);
      const messageType = match ? match[1] : null;
      if (!messageType) return;

      const ackId = parseInt(messageType.substring(2));
      const pendingAck = this.pendingAcks.get(ackId);

      if (pendingAck) {
        this.pendingAcks.delete(ackId);
      }

      const ackData = JSON.parse(data.substring(3));

      if (pendingAck?.event === "joinRoom") {
        this.requestMessageHistory();
      } else if (pendingAck?.event === "getMessageHistory") {
        const messages = ackData[0];
        if (Array.isArray(messages)) {
          this.messageHistory = messages;
          this.emit("messageHistory", this.messageHistory);
          // Emit existing history as individual messages so the UI updates nicely
          this.messageHistory.forEach(msg => this.emit("message", msg));
        }
      } else if (pendingAck?.event === "sendMessage") {
        if (ackData[0] && ackData[0].error) {
          this.emit("serverError", ackData[0]);
        }
      }
    } catch (error) {
      console.error("Error parsing numbered acknowledgment", error);
    }
  }

  private handleNewMessage(message: IMessage) {
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.messageHistoryLimit) {
      this.messageHistory.shift();
    }
    this.emit("message", message);
  }

  private requestMessageHistory() {
    const historyAckId = this.getNextAckId();
    this.pendingAcks.set(historyAckId, { event: "getMessageHistory", timestamp: Date.now() });
    this.send(`42${historyAckId}["getMessageHistory",{"roomId":"${this.roomId}","before":null,"limit":${this.messageHistoryLimit}}]`);
  }

  private send(data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private startPing(interval: number) {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.send("2");
    }, interval);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      this.emit("maxReconnectAttemptsReached");
    }
  }

  public disconnect() {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  public getMessages(limit?: number) {
    if (limit) {
      return this.messageHistory.slice(-limit);
    }
    return [...this.messageHistory];
  }

  public getLatestMessage() {
    return this.messageHistory[this.messageHistory.length - 1] || null;
  }

  public sendMessage(message: string) {
    if (this.isConnected) {
      const sendAckId = this.getNextAckId();
      this.pendingAcks.set(sendAckId, { event: "sendMessage", timestamp: Date.now() });
      this.send(`42${sendAckId}["sendMessage",{"roomId":"${this.roomId}","message":"${message}","username":"${this.username}"}]`);
    }
  }

  private getNextAckId(): number {
    const currentId = this.ackId;
    this.ackId = (this.ackId + 1) % 10;
    return currentId;
  }

  private cleanupStaleAcks() {
    const now = Date.now();
    const timeout = 30000;
    for (const [id, ack] of this.pendingAcks.entries()) {
      if (now - ack.timestamp > timeout) {
        this.pendingAcks.delete(id);
      }
    }
  }

  public isActive() {
    return this.isConnected;
  }
}
