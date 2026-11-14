// The one function Vercel runs. The API is built first (nest build), and this hands every request to the built app.
export { default } from '../dist/serverless.js';
