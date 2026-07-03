import type { ImageLoaderProps } from "next/image";

// Scryfall's image CDN now rejects requests sent with a default HTTP-library
// User-Agent (HTTP 400, subcode `generic_user_agent`). Next's image optimizer
// fetches the upstream image with Node's default `fetch` UA, so every
// /_next/image request for a cards.scryfall.io URL fails. These are already
// optimized CDN JPEGs, so we load them straight in the browser (whose own UA
// Scryfall accepts) and bypass the optimizer. Everything else keeps Next's
// default optimized path.
export default function imageLoader({ src, width, quality }: ImageLoaderProps): string {
  if (src.startsWith("https://cards.scryfall.io/")) {
    return src;
  }
  return `/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality ?? 75}`;
}
