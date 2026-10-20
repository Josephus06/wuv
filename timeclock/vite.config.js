import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative asset paths: the Android build loads dist/ from the app's own local scheme, not
// from a server root.
export default defineConfig({
  plugins: [react()],
  base: './',
});
