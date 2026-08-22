# Spored

A new game, branched from the Furry Dockers build so it starts with a working base rather
than an empty folder. Nothing here is settled yet — the name is a placeholder and the
whole thing is expected to diverge.

## What it inherits

- A single skinned GLB character driven as an **active ragdoll**: Cannon bodies per joint,
  fixed-length constraints, and low-strength muscle targets pulling toward a walk pose.
- A **character customiser** that glues pieces (horns, ears, tails, wings, fins, spikes,
  antennae) onto the mesh wherever you tap. Pieces bind to the bone that owns that patch of
  skin and ride the ragdoll with no per-frame code.
- A **first-person mode** built for motion sickness: no bob, no roll, collapsed head, a
  near-camera dissolve so the near plane never slices the body, and a partial-ragdoll
  STEADY control.
- **PeerJS rooms** for up to eight players, with a 152-byte binary pose packet and snapshot
  interpolation.

See `projects/furry-dockers/README.md` for the reasoning behind each of those, including
the measurements that settled the tuning.

## Deliberate differences from Furry Dockers

- `PEER_PREFIX` is `spored-`, so room codes cannot collide with Furry Dockers on the shared
  PeerJS signalling server. Two games using one public broker would otherwise fight over the
  same four-letter codes.
- The entry component is `SporedGame.tsx`.

## Working on it

Editable React/TypeScript source is in `source/`. `npm install && npm run build` there, then
copy `dist/assets/*` to `assets/` and `dist/index.html` to `index.html` — the same flow the
other projects use, since the site is served as static files from GitHub Pages.
