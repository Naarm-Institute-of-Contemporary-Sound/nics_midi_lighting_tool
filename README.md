# NICS MIDI Lighting Studio

[Check it out!](https://naarm-institute-of-contemporary-sound.github.io/nics_midi_lighting_tool/)

Static client-side studio for converting audio or MIDI into a low-note MIDI trigger map for Ableton -> TouchDesigner -> DMX workflows.

## Local Development

```bash
npm install
npm run dev
```

The preview build serves at `http://127.0.0.1:4173/`.

## Build

```bash
npm run build
npm run preview
```

## Basic Pitch Smoke Test

```bash
node scripts/test-basic-pitch-file.mjs "C:\path\to\audio.flac"
```

The build copies Spotify Basic Pitch model assets from `node_modules` into `public/basic-pitch-model` before Vite creates `dist`.
