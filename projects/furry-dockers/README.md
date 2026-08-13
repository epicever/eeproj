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
- **Adjustable FOV and sensitivity**, invert Y, body visibility, and body steadiness, all
  in the VIEW panel.
- **Hands stay in frame.** A raised hand is aimed at a fixed spot on screen rather than at
  a world-space ray from the shoulder, so looking up or down carries it along instead of
  swinging it out of view. See below.

## Two answers to the wobbling headless body

Seeing your own decapitated torso lurch around while you dash back and forward is the
classic problem with putting a camera inside a physics character. Both standard fixes are
implemented and switchable in the VIEW panel, so they can be compared directly. Defaults
are `FULL BODY` and `STEADY 0%`, which is the original behaviour.

### 1. `ARMS ONLY` / `SOFT FADE` — the viewmodel answer

What Quake, Half-Life and Counter-Strike do: show the arms and nothing else. Because the
whole character is one skinned mesh, and because the arms hang off the spine (so scaling
the spine bone away would take the arms with it), this uses a **per-bone visibility mask**
in the skinning shader. The vertex stage sums the mask over each vertex's four bone
influences — the usual way to carve a viewmodel out of a shared mesh. `NO BODY` masks the
arms too.

The mask has two channels. *Hard* hides outright. *Feather* hides only where the body comes
near the eye, dissolving over 0.3–1.1 units, which is the same near-camera dissolve
third-person games use to fade a character that gets between you and the camera. The
dissolve is a dithered discard driven by interleaved gradient noise, so it costs nothing in
transparency sorting. A vertex sitting on a seam picks up a mix of both channels through
its skin weights, which is what softens an edge instead of cutting it.

On top of both, a **near-camera guard** runs in every first-person mode. The eye sits
inside the collar, so without it the near plane slices straight through the mesh and leaves
a hard cut edge across the view — no amount of mask feathering helps, because a near-plane
cut is a hard edge by definition. The guard dissolves anything within 0.09–0.42 units, so
geometry is gone before it can reach the near plane at 0.06. Measured: the closest
surviving body fragment sits at 0.094 looking down and 0.188 looking level, where
previously geometry reached 0.06 — exactly the near plane, which is what was being cut.

- `ARMS ONLY` hard-hides the body but *feathers the shoulders*, so the arms dissolve away
  at the top rather than ending on a cut edge.
- `SOFT FADE` feathers the whole body instead of hard-hiding it.

One honest caveat about `SOFT FADE`: from inside your own head, nearly everything you can
see of yourself is close. Measured looking down, 619k of the 640k visible body pixels sit
within 0.6 units of the eye. So a near-camera fade dissolves almost all of the visible
body, and `SOFT FADE` ends up within 0.07% of `ARMS ONLY` in raw coverage — what separates
them is the softness of the edge, not how much body survives. Reaching the band as far as
the hips just reinvents `ARMS ONLY` outright, which is why it stops at 1.1.

The shadow pass is deliberately left unpatched, so a hidden body still casts its full
silhouette on the ground. Measured looking straight down, `ARMS ONLY` changes 78% of the
frame versus `FULL BODY`, while the character's own cast shadow still accounts for 11% of
the frame with the body fully masked.

- **Good:** no headless torso, nothing can lurch into the camera, arms read clearly.
- **Costs:** looking down shows floor rather than a body, which is less grounded. Your
  shadow still has a head and a body, which is either a nice cue or a giveaway.

### 2. `STEADY` — the partial-ragdoll answer

What Unreal and Unity call **physics blend weight**: keep the whole body, run the
simulation untouched, and only pull the pose that gets skinned back toward what the muscles
were asking for. At 0% the body is pure physics; at 100% it follows the walk intent almost
exactly. Blending toward the muscle target rather than toward the bind pose is what keeps
the legs stepping instead of going rigid.

Measured while dashing back and forward, torso sway (RMS deviation of the chest relative to
the character root) falls from 0.46 at 0%, to 0.24 at 50%, to 0.019 at 100% — a 96%
reduction. The foot still lifts 0.216 units per stride at 100%, so the walk survives.

Those muscle targets are a spring's input, not a display pose: `acceleration` is a raw
per-frame finite difference and the walk curves have corners in them. The ragdoll used to
smooth all of that on the way to the screen, so blending it out turned the pose jerky
whenever direction changed quickly. The intent signal is therefore filtered before it is
blended in, which cut pose jerk (RMS second derivative of the chest while dashing) from 190
to 35 while keeping 95% of the stride. Filtering harder keeps cutting jerk — 21 at roughly
double the strength — but flattens the stride to 62%, so it stops there.

- **Good:** keeps a real body under you, so looking down still shows a character.
- **Costs:** the higher you push it, the less this reads as a floppy ragdoll game. It also
  applies only in first person and is reflected in the pose sent to other players, so
  switching views changes how loose you look to everyone — the same way engines blend
  physics per character rather than per viewer.

The two combine: `FULL BODY` with `STEADY` around 40–60% keeps a visible body while taking
out most of the lurch.

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
