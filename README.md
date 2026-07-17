# DKMediaViewer

DKMediaViewer is a minimalist, performant, and elegant photo and video viewer for React that was extracted from [diklein.com](https://diklein.com). I am releasing it to share the work that went into making this UX delightful, and to let anyone give their own photos and videos the same experience.

Features:
- Masonry grid
- Fly-in lightbox with swipe and arrow-key navigation
- A crossfading carousel component
- Captions and camera EXIF data
- Light and dark modes
- Reduced-motion support
- Oh... and one easter egg

The `DK` prefix is of course an homage to NeXTSTEP's `NS` prefixes.

**Live demo & docs:** [diklein.com/dkmediaviewer](https://diklein.com/dkmediaviewer)

## Install

The viewer is distributed through the [shadcn registry](https://ui.shadcn.com/docs/registry). The CLI drops the source code right into your project. 

```bash
npx shadcn@latest add https://diklein.com/r/dk-media-viewer.json
```

React 18+ and Tailwind CSS v4 are required. The only npm dependency it brings in is [`motion`](https://motion.dev).

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
  caption: 'Marin Headlands, October.',   // optional: shown in the lightbox rail
  width: 2048, height: 1365,              // optional: avoids layout shift
  exif: {                                  // optional: the mono spec line
    make: 'Ricoh', model: 'GR IIIx',
    exposureTime: '1/500', aperture: '2.8', focalLength: '26.1', iso: 200,
  },
  videoSrc: '/photos/clip.mp4',           // optional: makes it a video (src = poster)
}
```

Optional data like EXIF and caption degrade elegantly.

## You can also point DKMediaViewer at a folder

You don't have to write `media-items.json` yourself. Point the CLI at your photo folder and it generates the file for you. Dimensions and camera settings come from the EXIF embedded in each image.

```bash
npx dkmediaviewer scan ./public/photos --out src/lib/media-items.json
```

Videos need a poster image because it gives a video something to show instantly (in the grid, mid-animation, or when a device blocks autoplay) instead of a black box while the video loads. Give a video and an image the same name, like `clip.mp4` and `clip.jpg`, and the scanner joins them into a single video item. The clip plays and the image is its poster frame.

## One file per photo is enough

The grid and the lightbox share `src`, so a single reasonably large image works out of the box. The browser scales it down in the grid and shows it full size in the lightbox.

If you serve responsive sizes through a CDN or an image optimizer, pass `getHiResSrc`. The lightbox always opens by animating the image already on your screen, then fades in the sharper version once the animation has landed, so the upgrade never delays the open.

```tsx
<DKMediaViewer
  items={items}
  getHiResSrc={(item) => item.src.replace('w=800', 'w=2048')}
/>
```

## The carousel

A second component, `DKCarousel`, runs the same items as a crossfading slideshow that auto-advances. Click a slide and the lightbox opens over the whole set, navigable with the same arrows.

```tsx
import { DKCarousel } from '@/components/dk-media-viewer/dk-carousel'

<DKCarousel items={items} ratio="3 / 2" />
```

## The details

- **The open animation starts from the thumbnail:** The lightbox animates the image already on your screen into place instead of fetching a new copy mid-flight. No re-fetch, no flash.
- **Lightbox navigation:** swipe with axis-lock and rubber-banding at the ends. Arrow keys and on-screen controls can also switch assets. A swipe down will dismiss the lightbox on mobile.
- **A real modal:** Everything behind the modal goes `inert` and focus enters the dialog. The `Tab` key cycles controls, and a close hands focus back to the item you were viewing (with a focus ring appearing only for keyboard users).
- **Light and dark mode** via the `.dark` class (shadcn convention), falling back to `prefers-color-scheme`. Every color is a `--dk-*` variable.
- **`prefers-reduced-motion`** is honored everywhere: no autoplay, no shimmer sweep, and instant transitions.
- **Videos** keep playing through the open animation and hand off frame-accurately to the modal player. This was inspired by the minimize feature Steve Jobs [demonstrated](https://youtu.be/2GkoAa5718Y?t=165) in the Mac OS X introduction in 2000.

## The easter egg

Hold the `Shift` key while clicking a photo (or while pressing an arrow key inside the lightbox) and the animation runs at one-tenth speed. Mac OS X 10.3 shipped shift-click-minimize as a slow-motion genie effect, and Exposé kept the tradition. Some of us never got over it.

## Theming

```css
.dk-scope {
  --dk-accent: #0f62fe;                 /* video progress bar, focus rings */
  --dk-font-mono: 'Berkeley Mono', ui-monospace, monospace;  /* the EXIF line */
}
```

## License

MIT © [David Klein](https://diklein.com)
