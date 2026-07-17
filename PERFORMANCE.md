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
3. Select `상품 상세사진 전체 최적화` once to create dedicated maximum 1080px WebP files for the representative image and every detail image.
4. Each representative image and each detail image is saved immediately after it succeeds, so an interrupted run can resume without repeating completed images.
5. Use `목록 썸네일만 생성` only for product-card thumbnails, or use the per-product `상세사진` and `목록사진` buttons.
6. If an image fails, run the same detail optimization again; only missing optimized images are retried.
7. Confirm the product row shows both `썸네일 적용` and `상세사진 1080px 적용`.

The original `img` and `extraImgs` catalog values and Storage files are preserved. Product detail and lightbox views prefer `detailImageUrl` and the position-matched `detailExtraImgs` array, while `thumbnailUrl` remains exclusive to product cards.

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
