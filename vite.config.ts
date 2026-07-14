export default {
  cacheDir: ".vite-cache",
  resolve: {
    alias: {
      "lucide-react": new URL("./src/icons.tsx", import.meta.url).pathname,
    },
  },
  server: {
    hmr: process.env.DISABLE_HMR !== "true",
  },
};
