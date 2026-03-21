import { Client } from "@gradio/client";

const HF_SPACE = "AdamSongjam/ultimate-rvc";
const HF_BASE = "https://adamsongjam-ultimate-rvc.hf.space";

/**
 * Generates TTS audio using the Ultimate RVC Hugging Face Space.
 *
 * @param text The text to be converted to speech.
 * @param voiceModel The RVC voice model ID (e.g., "mr_krabs").
 * @param ttsVoice The base edge-tts voice (default: "en-US-ChristopherNeural").
 * @param onStatus Optional callback to receive status updates (queue pos, eta).
 * @returns A promise that resolves to the generated audio URL.
 */
export async function generateHuggingFaceTts(
  text: string,
  voiceModel: string,
  ttsVoice: string = "en-US-ChristopherNeural",
  onStatus?: (status: { stage: string; position?: number; eta?: number }) => void
) {
  // 1. Connect to the Hugging Face Space
  const client = await Client.connect(HF_SPACE);

  // 2. Fire-and-forget wake call to populate server-side models
  await client.predict("/_init_dropdowns", {});

  // 3. Submit TTS + RVC job
  const job = client.submit(
    51,
    [
      text, // 0  tts_text
      voiceModel, // 1  rvc_model slug
      ttsVoice, // 2  edge-tts voice
      0, // 3  pitch
      0, // 4  filter_radius
      0, // 5  rms_mix_rate
      0, // 6  protect
      0, // 7  hop_length
      "rmvpe", // 8  f0_method
      0.3, // 9  crepe_hop_length
      1, // 10 f0_autotune
      0.33, // 11 f0_autotune_strength
      false, // 12 f0_vad
      false, // 13 split_audio
      1, // 14 batch_size
      false, // 15 clean_audio
      155, // 16 clean_strength
      true, // 17 export_format
      0.7, // 18 rms_mix_rate (secondary)
      "contentvec", // 19 embedder_model
      null, // 20 embedder_model_custom
      0, // 21 sid
      0, // 22 batch_threshold
      44100, // 23 sample_rate
      "mp3", // 24 output_format
      "", // 25 extra
    ],
    undefined,
    undefined,
    true,
  ); // true = receive status events

  // 4. Listen to the event stream
  for await (const event of job) {
    if (event.type === "status") {
      const statusEvent = event as any;

      if (statusEvent.stage === "pending") {
        console.log(`Queued at position: ${statusEvent.position}`);
        onStatus?.({ stage: "pending", position: statusEvent.position });
      } else if (
        statusEvent.stage === "generating" ||
        statusEvent.original_msg === "process_starts"
      ) {
        console.log(`Processing... ETA: ${statusEvent.eta}s`);
        onStatus?.({ stage: "generating", eta: statusEvent.eta });
      }
    } else if (event.type === "data") {
      // 5. Final audio data received
      const output = (event as any).data?.[0];
      let audioUrl = typeof output === "string" ? output : output?.url;

      if (audioUrl?.startsWith("/")) {
        audioUrl = `${HF_BASE}${audioUrl}`;
      }

      console.log("Audio generated successfully! URL:", audioUrl);
      return audioUrl;
    }
  }
}

/**
 * Download and process a voice model via the HF space's /_wrapped_fn_7 endpoint
 */
export async function downloadAndProcessVoiceModel(modelUrl: string, modelName: string) {
  const client = await Client.connect(HF_SPACE);
  const result = await client.predict("/_wrapped_fn_7", {
    param_0: modelUrl,
    param_1: modelName,
  });
  return result;
}

/**
 * Test Hugging Face Space connection
 */
export async function testHFSpace() {
  const client = await Client.connect(HF_SPACE);
  const result = await client.predict("/partial_70", {});
  console.log("Test result:", result);
  return result;
}
