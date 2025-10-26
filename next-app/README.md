# Next.js UI for Zurg Media Organizer

This is a minimal Next.js frontend that talks to the existing Express backend in the repository.

Quick start (from repo root):

```bash
# install dependencies for the Next app
cd next-app
npm install

# run dev server on http://localhost:3000
npm run dev
```

Notes:
- The Next app expects the backend Express server to be running at http://localhost:4004 (the default for this repo).
- This is an initial port of the UI. It uses the backend JSON endpoints under `/api/*` added to the Express app.
- For production usage you'll want to build (`npm run build`) and run (`npm run start`) and optionally reverse-proxy or configure the host/port.
