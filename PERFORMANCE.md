# Initial Transfer Optimization

## What changed

- `index.html` is now the public order page only. It no longer contains administrator markup, order-management code, CSV export, image upload, statistics, or order notification listeners.
- `/admin/` is served by `admin/index.html`. The root `admin.html` redirects to this path for old links.
- The public page reads only the catalog and notice documents during startup. Order lookup and review verification remain on-demand actions.
- Google web-font downloads were removed from the public page in favor of Korean system fonts.
- Daum postcode is loaded only after the user selects `우편번호 찾기`.
- Product cards read `thumbnailUrl` first. Card image URLs are assigned only when a card comes within 50px of the viewport, then native lazy loading and async decoding apply.
- Detail images are created only when a product detail modal opens. The first detail image is eager; the rest are lazy. Closing the modal removes detail image sources from the DOM.
- Broken product images use the small local `assets/product-placeholder.svg` fallback without repeating the failed remote request.

## Image migration

Existing products keep using `img` until a `thumbnailUrl` exists. That fallback preserves current product images, but it cannot guarantee the 1-3MB first-visit target when old originals are large.

1. Open `/admin/` and authenticate.
2. Open `상품/공지`.
3. Select `전체 이미지 최적화` once to create a maximum 1080px WebP representative image, maximum 1080px WebP detail images, and a 480px WebP thumbnail for every existing product.
4. The catalog switches to the optimized URLs after each product succeeds. Existing files remain in Firebase Storage and registered image order is preserved.
5. `전체 썸네일 생성` remains available when only card thumbnails are needed, or use the per-product `썸네일` button.
6. If an external image blocks browser conversion because of CORS, open `수정` and upload the image file directly.
7. Confirm the product row shows `썸네일 적용`.

The original Storage files are not deleted during migration. The catalog's `img` and `extraImgs` URLs are replaced with optimized copies, and `thumbnailUrl` is used for product cards.

New representative uploads are automatically converted to a maximum 1080px detail image and a 480px list thumbnail. New detail-image uploads are capped at 1080px. The detail modal and lightbox use the same 1080px optimized URLs instead of loading separate originals. Generated files prefer WebP, fall back to JPEG where WebP encoding is unavailable, and receive a one-year immutable browser cache header.

## Expected first-visit image transfer

After all products have 50-120KB WebP thumbnails, the public page initially requests only the visible first row: normally two images on mobile or three on desktop, about 100-360KB of product imagery. Later card images load while scrolling. Before migration, the same viewport gating prevents all original images from downloading at once, but the visible originals can still be large. Detail images load only after selecting the corresponding product.

Total transfer also includes Tailwind, Font Awesome, Firebase modules, and browser cache state. Measure the deployed site after thumbnail migration; the 3MB target cannot be confirmed from source code alone.

## Validation checklist

1. In Chrome DevTools, open Network and enable `Disable cache`.
2. Open the public order page and reload. Confirm no request for `/admin/` or `admin/index.html` occurs.
3. Confirm only the first visible product card thumbnails load initially; scroll to load later cards.
4. Clear Network, open one product, and confirm only that product's representative/detail images load.
5. Close the modal and confirm its image elements no longer have `src` values.
6. Open `/admin/`, authenticate, and confirm product editing, thumbnail upload, and CSV/statistics still work.
