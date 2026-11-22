# VGU chess analysis board

A lichess-style analysis board used by the commentators of the VGU Sport Week 2026 chess tournament stream:
legal moves, move tree with variations, Stockfish 19 (in the browser), arrows (knight jumps drawn as an L),
an editor, and reading a position from a photo of a real board. Two laptops share one board through a private
VDO.Ninja data room; each laptop asks for access and the stream admin approves it by hand.

Uses: [chessground](https://github.com/lichess-org/chessground) and [chessops](https://github.com/niklasf/chessops) (GPL-3.0),
[Stockfish 19 lite](https://github.com/nmrugg/stockfish.js) (GPL-3.0), ChessQ Lite V6 (PolyForm Noncommercial 1.0.0, see
`lib/LICENSE-chessq.txt`), [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT),
[VDO.Ninja SDK](https://github.com/steveseguin/ninjasdk) (MPL-2.0), [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT).
The board's own code (app.js, sync.js, reader.worker.mjs, board.css) is GPL-3.0. Non-commercial use only, because of ChessQ.
