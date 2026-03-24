Use this folder for replay datasets in JSONL format.

Each line must be:
{"name":"case-name","request":{...TurnRequest}}

Run via POST `/api/agent/replay` with:
{"datasetPath":"data/replay/sample.jsonl"}
