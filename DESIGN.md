# WebGPU Aquarium

This is a ocean area simulation. It should be utterly beautiful and gorgeous.
It should have various kinds of fish, plants, urchins, Sea anemones, Sea horses,
jellyfish, rays, coral, shells, starfish, caustics, light rays, bubbles, etc...

Everything should look as amazing as the best AAA games and take inspiration from
Horizon Forbidden West, Subnautica 2, and other games known for beautiful underwater
rendering.

Assets should all be algorithmically generated so that each run is unique.
Where possible, generate using WebGPU compute shaders for speed.

Have at least one agent who's sole duty is to judge if the result matches AAA
games.

The project should be written in TypeScript using WebGPU. It will be built using
esbuild, gts for lint, using the newest versions that are compatible with each other.
Include an action for releasing on github pages.

The project can be tested with puppeteer, no special arguments are needed. If serving
the page use express for local testing.

For WebGPU, use modern WebGPU style. Add an uncapturederror handler so that error
messages will show up when run in puppeteer. Label all WebGPU objects so error
messages will be clear what's causing them.
