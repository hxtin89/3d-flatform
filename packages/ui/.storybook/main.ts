import type { StorybookConfig } from "@storybook/sveltekit";

const config: StorybookConfig = {
  framework: "@storybook/sveltekit",
  stories: ["../src/lib/**/*.stories.@(ts|svelte)"],
  addons: ["@storybook/addon-essentials"],
};

export default config;
