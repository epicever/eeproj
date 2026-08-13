# Furry Dockers

A top-down Three.js active-ragdoll playground using a single skinned GLB character, Cannon physics bodies, fixed-length constraints, low-strength muscle targets, and PeerJS rooms for up to eight players.

## Controls

- WASD or arrow keys: move — world-relative in top-down, view-relative in first person
- Shift: sprint
- Hold left mouse: raise the left arm
- Hold right mouse: raise the right arm
- Hold both mouse buttons: raise both arms
- V: switch between top-down and first person
- R: reset

## First person

Press **V** (or the VIEW button) to drop into the character's head. Click the stage to
capture the mouse for looking; **Esc** frees the cursor again. On touch devices, drag the
stage to look and tap to punch.

The view is built for people who get motion sick:

- **No bob at all.** The eye rides the smooth kinematic root at a fixed height rather than
  the ragdoll's head, so nothing in the view inherits the character's flailing. There is no
  walk bob, no landing dip, no camera roll, and no sprint FOV kick.
- **The head is hidden**, not just moved out of the way — the head bone is collapsed so the
  skull can never clip across the near plane. Other players still see your full character.
- **Decoupled head and body.** The camera turns instantly with the mouse while the body
  eases toward the new heading, so a fast flick never drags the view around with the ragdoll.
- **Instant view cuts.** Switching views is a hard cut; a swooping interpolation between two
  very different viewpoints is exactly the motion that makes people ill.
- **Dynamic tunnel vignette** that closes in while you move or turn quickly, and opens back
  up when you stop. Toggle it off if you don't want it.
- **Adjustable FOV and sensitivity**, invert Y, and a body-visibility toggle, all in the
  VIEW panel.
- Arms punch along the aim ray, pitch included, so your hands land where the crosshair is.

## Multiplayer

- Select **Create Room** to get a four-letter code.
- Share the code with up to seven other players.
- Other players enter the code and select **Join**.

Open `index.html` through the eeproj GitHub Pages site to play. Editable React/TypeScript source is in `source/`.
