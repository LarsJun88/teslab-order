# Initial Transfer Optimization

## What changed

- `index.html` is now the public order page only. It no longer contains administrator markup, order-management code, CSV export, image upload, statistics, or order notification listeners.
- `/admin/` is served by `admin/index.html`. The root `admin.html` redirects to this path for old links.
- The public page reads only the catalog and notice documents during startup. Order lookup and review verification remain on-demand actions.
- Google web-font downloads were removed from the public page in favor of Korean system fonts.
- Daum postcode is loaded only after the user selects `우편번호 찾기`.
- Product cards read `thumbnailUrl` first. The first three card images are high priority; later cards use native lazy loading and async decoding.
- Detail images are created only when a product detail modal opens. The first detail image is eager; the rest are lazy. Closing the modal removes detail image sources from the DOM.
- Broken product images use the small local `assets/product-placeholder.svg` fallback without repeating the failed remote request.

## Thumbnail migration

Existing products keep using `img` until a `thumbnailUrl` exists. That fallback preserves current product images, but it cannot guarantee the 1-3MB first-visit target when old originals are large.

1. Open `/admin/` and authenticate.
2. Open `상품/공지`.
3. Select `썸네일 생성` to create 480px WebP thumbnails for every product without one, or use the per-product `썸네일` button.
4. If an external image blocks browser conversion because of CORS, open `수정` and upload a prepared 400-480px WebP file in `목록 썸네일`.
5. Confirm the product row shows `썸네일 적용`.

The original `img` and `extraImgs` remain untouched. `thumbnailUrl` is only for product cards.

## Expected first-visit image transfer

After all products have 50-120KB WebP thumbnails, the public page initially requests only the first three thumbnails: about 150-360KB of product imagery. Later card images load while scrolling. Detail images load only after selecting the corresponding product.

Total transfer also includes Tailwind, Font Awesome, Firebase modules, and browser cache state. Measure the deployed site after thumbnail migration; the 3MB target cannot be confirmed from source code alone.

## Validation checklist

1. In Chrome DevTools, open Network and enable `Disable cache`.
2. Open the public order page and reload. Confirm no request for `/admin/` or `admin/index.html` occurs.
3. Confirm only the first visible product card thumbnails load initially; scroll to load later cards.
4. Clear Network, open one product, and confirm only that product's representative/detail images load.
5. Close the modal and confirm its image elements no longer have `src` values.
6. Open `/admin/`, authenticate, and confirm product editing, thumbnail upload, and CSV/statistics still work.
