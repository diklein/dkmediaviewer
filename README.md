# DKMediaViewer

A photo & video viewer for React, extracted from [diklein.com](https://diklein.com) — where every detail was argued over on a real site before it got here. Masonry grid, a fly-in lightbox that turns your thumbnail's own pixels into the modal, swipe/keyboard carousel, captions and camera EXIF when they exist, light & dark, reduced-motion, and one easter egg.

The `DK` prefix is an homage to NeXTSTEP — this is an `NSView` that took photography classes.

**Live demo & docs:** [diklein.com/dkmediaviewer](https://diklein.com/dkmediaviewer)

## Install

Distributed as a [shadcn registry](https://ui.shadcn.com/docs/registry) — the CLI drops the **source code** into your project. No package to depend on, nothing to lock; the code is yours to keep or change.

```bash
npx shadcn@latest add https://diklein.com/r/dk-media-viewer.json
```

Requires React 18+ and Tailwind CSS v4. The only npm dependency it brings is [`motion`](https://motion.dev).

## Use

```tsx
import { DKMediaViewer } from '@/components/dk-media-viewer/dk-media-viewer'
import items from '@/lib/media-items.json'

export default function Gallery() {
  return <DKMediaViewer items={items} />
}
```

An item is just:

```ts
{
  src: '/photos/golden-gate.jpg',
  alt: 'Golden Gate Bridge in fog',
  caption: 'Marin Headlands, October.',   // optional — shown in the lightbox rail
  width: 2048, height: 1365,              // optional — avoids layout shift
  exif: {                                  // optional — the mono spec line
    make: 'Ricoh', model: 'GR IIIx',
    exposureTime: '1/500', aperture: '2.8', focalLength: '26.1', iso: 200,
  },
  videoSrc: '/photos/clip.mp4',           // optional — makes it a video (src = poster)
}
```

Everything optional degrades cleanly: no EXIF → no spec line, no caption → the photo gets the space.

## Or point it at a folder

You don't have to write that array. Scan a folder and the real EXIF comes straight out of the files:

```bash
npx dkmediaviewer scan ./public/photos --out src/lib/media-items.json
```

Dimensions and camera settings are read from each image; `clip.mp4` + `clip.jpg` pairs become video items automatically.

## The details

- **The open animation is the thumbnail.** The lightbox flies the already-decoded pixels from the grid into place — no re-fetch, no flash, spring-physics all the way.
- **Carousel** — swipe with axis-lock and rubber-banding at the ends, arrow keys, on-screen controls; swipe down to dismiss.
- **A real modal** — everything behind it goes `inert`, focus enters the dialog, Tab cycles its controls, and close hands focus back to the item you were viewing (with a focus ring only for keyboard users).
- **Light & dark** via the `.dark` class (shadcn convention), falling back to `prefers-color-scheme`. Every color is a `--dk-*` variable — retheme in one selector.
- **`prefers-reduced-motion`** honored everywhere: no autoplay, no shimmer sweep, instant transitions.
- **Videos** keep playing through the open animation and hand off frame-accurately to the modal player.

## The easter egg

Hold **Shift** while clicking a photo — or while pressing an arrow key inside the lightbox — and the animation runs at one-tenth speed. If you know why, you know. (Mac OS X 10.3 shipped shift-click-minimize as a slow-motion genie effect, and Exposé kept the tradition. Some of us never got over it.)

## Theming

```css
.dk-scope {
  --dk-accent: #0f62fe;                 /* video progress bar, focus rings */
  --dk-font-mono: 'Berkeley Mono', ui-monospace, monospace;  /* the EXIF line */
}
```

## License

MIT © [David Klein](https://diklein.com)
