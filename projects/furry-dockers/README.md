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
- **Hands stay in frame.** A raised hand is aimed at a fixed spot on screen rather than at
  a world-space ray from the shoulder, so looking up or down carries it along instead of
  swinging it out of view. See below.

## Keeping hands and held items on screen

Most first-person games never show you the real arms. They render a separate *viewmodel*
rig parented straight to the camera, in its own pass with its own FOV and a cleared depth
buffer, so it is always in frame and never clips into walls. What other players see is a
different model entirely.

That trick would throw away the point of this game, which is that the arms are floppy
physics bodies. Instead the arms stay physical and only their *target* moves into view
space:

- Each raised hand is given a screen position in normalized device coordinates
  (`HAND_SCREEN_X` / `HAND_SCREEN_Y`), not a world offset from the shoulder.
- Every point on the ray from the eye through that screen position projects to the same
  spot, so the target is found by intersecting that ray with the sphere the arm can reach
  and taking the far hit. The hand holds its place in frame and only its *depth* gives.
- If the ray passes entirely beyond reach, it falls back to the ray's closest approach, so
  the hand sits as near the mark as the arm allows rather than dropping out of view.
- Because the ray is built from the live FOV and aspect, the hand holds the same screen
  position at any FOV or window shape — the same reason games render viewmodels at a fixed
  FOV of their own.
- Weight is fed forward into the muscle so a held pose sits on its mark without the spring
  being stiffened, keeping the wobble.

Measured across the full pitch range (straight up to straight down) both hands stay within
x ±0.48–0.76 and y −0.27 to −0.57 in NDC, where ±1 is the screen edge. An item parented to
a hand bone inherits all of this for free.

## Multiplayer

- Select **Create Room** to get a four-letter code.
- Share the code with up to seven other players.
- Other players enter the code and select **Join**.

Open `index.html` through the eeproj GitHub Pages site to play. Editable React/TypeScript source is in `source/`.
