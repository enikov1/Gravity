# Gravity Defied — Project Memory

## Tech Stack
- TypeScript + esbuild (IIFE bundle)
- Phaser 3 (renderer, parallax, procedural graphics)
- Matter.js (physics engine)
- Yandex Games SDK (cloud saves, leaderboards, ads)

## Key Conventions
- Physics STEP = 1000/120 ms (120Hz fixed timestep)
- World scale: 10 units = 1 meter (used in distance calculation)
- Speed formula: `velocity * 60/30` (legacy scaling factor)
- No external textures — all art drawn via Phaser Graphics primitives

## Physics Architecture
- Bike = 2 wheels (circle) + chassis (rectangle) + head (circle)
- Constraints form suspension system (4 springs + 1 head anchor)
- Movement: `torque` on rear wheel (primary) + small `applyForce` on chassis (assist)
- Front wheel heavier than rear (density 0.0019 vs 0.0011) for stability — inspired by original GD
- Terrain generated procedurally per chunk (720 units)

### Bike Physics Parameters
| Parameter | Value | Notes |
|---|---|---|
| Rear wheel density | 0.0011 | mass ~1.0 |
| Front wheel density | 0.0019 | mass ~1.75 (heavier for stability) |
| Chassis density | 0.0024 | mass ~2.0 |
| Head density | 0.0016 | mass ~0.5 |
| Wheel friction | 0.5 + grip*0.06 | |
| Wheel frictionStatic | 0.01 | must be low to allow rotation |
| Wheel restitution | 0.02 | |
| Constraint stiffness | 0.7 + suspension*0.04 | |
| Constraint damping | 0.12 (wheels), 0.08 (cross) | |
| Engine max torque | 0.8 + power*0.1 + bike*0.13 | on rear wheel |
| Engine gain | 0.6 + power*0.08 + bike*0.1 | |
| Chassis assist force | 0.0006 + upgrades | small forward push |
| Balance authority | 0.55 (grounded) / 0.35 (air) | chassis torque |
| Rotational drag | 0.6 (grounded) / 0.25 (air) | stability |

## Terrain / Chunk System
- Chunk size: 720 units
- 8 chunk types: flat, hills, uphill, downhill, jump, pit, spiral, cliff
- Progressive difficulty: weights change every 3 chunks (level = floor(index/3) + floor(difficulty/2))
- Smooth transitions via targetHeight interpolation between chunks
- Obstacles (rocks, barrels, platforms, beams) scale with level
- Gaps on jump/cliff chunks

## Game Modes
- `campaign` — 6 fixed tracks with star ratings
- `progression` — endless with increasing chunk difficulty
- `daily` — daily challenge with modifiers
- `endless` — simple endless (legacy)
- `custom` — seed-based procedural track

## UI Screens
- `#menu-screen` — main menu (logo, play/shop/leaderboard)
- `#track-screen` — track selection with tabs
- `#race-hud` — in-game HUD (progress, time, coins)
- `#speedometer` — bottom-right speed display
- `#touch-controls` — mobile controls (left/right tilt, brake/gas)
- `#modal-backdrop` + `#modal` — modal dialogs

## Build
```bash
npm install
npm run build   # outputs game.js
```
