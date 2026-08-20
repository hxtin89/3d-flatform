import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // no Node runtime at deploy (Apache, static) — this package only ever
    // needs a static adapter for its own SvelteKit shell (Storybook/demo route).
    // The actual BentoWidget/LabelLine components are published as a plain
    // component library via @sveltejs/package and consumed by `viewer`
    // (a non-SvelteKit Vite app) with no adapter involved at all.
    adapter: adapter({ fallback: "index.html" }),
  },
};

export default config;
