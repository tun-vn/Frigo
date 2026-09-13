# Frigo Project Status

## Final hardening — source verification, not a production deployment (2026-09-08)

The current release status is in `FINAL_HARDENING_REPORT.md`; historical **LIVE**
entries below describe earlier operations, not proof of today's production SHA
or schema. Final hardening preserves the session/OTP/quota/queue architecture,
fixes reset privacy, mandatory production Turnstile, quota/origin drift,
multi-household `/me`, and adds client/release/cleanup regressions. Production
identity remains unverified from repository deployment metadata. Merge requires
exact-head hosted CI; deployment and all payment work remain separate owner actions.

## M24: Week reconciliation, recovery & dual-write canary (2026-09-06) — LIVE
- Thêm reconciliation read-only v1/v2 theo plan với canonical DTO, SHA-256, row-count, orphan và content mismatch report.
- Strict gate chặn vacuous parity: plan `READY|ACTIVE|COMPLETED` không có day rows không được coi là parity dù checksum hai tập rỗng bằng nhau.
- Phát hiện 2 plan `READY` lịch sử không có `snapshot_json`, day, slot hoặc shopping row; đã backup D1 và khôi phục chính xác từ KV snapshot còn hiệu lực bằng `scripts/week-repair-from-kv.mjs`.
- Post-repair strict reconciliation pass `2/2`: plan 1 có `7/7` days, `7/7` slots, `14/14` shopping; plan 2 có `7/7` days, `9/9` slots, `16/16` shopping; checksum v1/v2 khớp và không orphan.
- Đã bật production `WEEK_SCHEMA_MODE=dual`, chạy guest canary tạo mới `7/7` days, `7/7` slots, `18/18` shopping với checksum parity; dữ liệu canary sau đó được dọn khỏi D1/KV và final parity vẫn phải giữ xanh.
- Thêm integration harness Hono + JWT + SQLite/D1 adapter chạy migrations `0001`-`0012`, bao phủ create/regenerate/swap, shopping import idempotency và cooking FIFO/replay.
- Release gate: `CHECK_REMOTE_SCHEMA=1 CHECK_WEEK_PARITY_REMOTE=1 pnpm check`; production vẫn đọc v1, chưa bật `v2-read`.

## M25: Cloudflare auth protection (2026-09-07) — COMPLETED
- Đã tạo Turnstile Managed widget `frigo-auth` cho zone `tungjpstore.net`; `TURNSTILE_SITE_KEY` và secret đã được triển khai production (secret chỉ lưu bằng Wrangler Secret).
- Đã xác minh `/api/v1/config` trả site key, form auth tải widget khi có cấu hình, và request auth thiếu token bị từ chối `403 TURNSTILE_FAILED`.
- Email Routing của root domain vẫn giữ Zoho MX; không tự động thêm Cloudflare MX vì sẽ gây xung đột với hệ thống mail đang hoạt động.

## M22: Core integrity production rollout (2026-09-06) — DEPLOYED LIVE
- Đã backup D1 production trước migration tại `.artifacts/frigo-db-pre-0010.sql`.
- Đã apply và xác minh migrations `0007` đến `0010`; D1 Console hiển thị đủ lịch sử `0001` đến `0010`, đủ ba bảng Week v2 và `PRAGMA foreign_key_check` không có lỗi.
- Đã deploy Worker production version `da10ef84-cd04-4efb-ab97-831ff0c8b76c` lên `https://frigo.tungjpstore.net` với đầy đủ binding D1, KV, R2, Queue, Workers AI và Email Service.
- Đã bật Workers Logs với invocation logs, persistence và sampling 100%; cấu hình được lưu trong `wrangler.jsonc` để tránh drift giữa Dashboard và Wrangler.
- Post-deploy smoke pass: SPA 200, health 200 (`aiMockMode: false`), recipes 200 (71 món), inventory không token trả 401, security headers hoạt động.
- Week v2 hiện chỉ là shadow/observational; Worker vẫn đọc/ghi v1. Không bật v2-read trước khi có dual-write, catch-up reconciliation và parity check.
- Migration `0011_meal_plan_tenant_ownership.sql` đã apply production sau backup `.artifacts/frigo-db-pre-0011.sql`; trigger bất biến `meal_plans.household_id` ngăn race đổi chủ plan.

## M23: Staged Week dual-write scaffold (2026-09-06) — DEPLOYED DORMANT
- Thêm `WEEK_SCHEMA_MODE=legacy|dual`; production đang khóa ở `legacy`, nên chưa ghi vào Week v2 và chưa đổi read path.
- Mode `dual` kiểm tra capability đủ ba bảng/cột v2 trước mutation; thiếu schema sẽ fail-closed trước `db.batch()`.
- Create/regenerate/swap/meal patch/shopping patch dùng chung `persistPlanRelational`; khi bật dual, cleanup và insert v1/v2 chạy trong cùng D1 batch để không tạo drift một phía.
- Thêm release schema gate read-only `pnpm schema:check:remote`; `CHECK_REMOTE_SCHEMA=1 pnpm check` chạy cả schema fingerprint/FK gate.
- Đã deploy scaffold production version `8c5c8818-ede7-4683-a348-11607b04b228`, nhận 100% traffic với mode `legacy`.
- Gate: 106 tests pass, typecheck/lint/build/migration smoke `0001`-`0011` và remote schema gate đều pass tại thời điểm scaffold; các release sau đã mở rộng lên `0012`.

## M19: Guest Data Migration & Ops Polish (2026-09-05) — DEPLOYED LIVE
- **Guest data migration (commit `86f56f1`)**: Khách vãng lai thêm đồ vào tủ lạnh trước khi đăng ký sẽ không mất dữ liệu:
  - `POST /auth/verify-otp` (purpose=register) nhận `migrateFromHouseholdId` tùy chọn (Zod schema bắt buộc prefix `hh_guest_*`).
  - Server tự tạo `households` + `household_members` cho household mới trước khi chuyển dữ liệu (an toàn FK).
  - Chuyển `inventory_items`, `inventory_events`; gộp hoặc chuyển `shopping_lists`/`shopping_items`; copy KV weekly plan cache; invalidate cache kho.
  - Best-effort: lỗi migration không chặn đăng ký.
  - Client (`AuthPage`) chỉ gửi householdId khi `isGuest` và prefix khớp `hh_guest_`.
- **U1 (commit `af71b00`)**: Nâng cấp giao diện mobile-first — nav, home hero, cards, responsive.
- **Kiểm chứng live sau deploy `2dbb1406`**: health 200, `aiMockMode: false`, security headers trên API và static assets hoạt động.

## M18: Security Audit Round 2 (2026-09-05) — DEPLOYED LIVE
- **B1**: OTP email thật qua Workers email binding + brute-force guard (5 lần sai/email/15 phút trong KV).
- **B2+B3**: Dọn vòng đời meal plan + sửa N+1 query khi import đi chợ.
- **B4**: AI fail-loudly trong production (không còn mock fixture lọt vào kho thật) + timeout 25s cho vision.
- **SEC-5**: Đóng bypass auth bằng raw token — guest nhận JWT có chữ ký.
- **B5**: Rate-limit theo user trên mọi route ghi đã đăng nhập.
- **SEC-6**: Turnstile chống bot trên register/login/forgot-password (kích hoạt khi đặt TURNSTILE_SECRET_KEY).
- **B6**: Email OTP native Cloudflare Workers (send_email binding, gói Paid) — không cần API key bên thứ 3; fallback Resend/MailChannels.
- **SEC-7/7b**: Security headers đầy đủ (CSP, HSTS 2y preload, X-Frame-Options DENY, Permissions-Policy camera=self) cả trên Worker lẫn static assets qua `public/_headers`.
- **SEC-8**: Google ID token bắt buộc khớp `aud` với OAuth Client ID — chặn cross-client token substitution. 3 unit test mới (match/mismatch/missing aud). Đã deploy live version `b46b57cf`.
- **Verify live**: health 200, `/auth/google` từ chối token giả 401, security headers hoạt động trên HTML và API.
- **Kiểm thử**: 44/44 unit tests passed, 0 TypeScript/Lint/Build errors.

## M17: Security Hardening & VN Recipe Bank Deployment (2026-09-05)
- **S1**: Google OAuth Client Secret bị lộ trong tài liệu/git history → đã xóa khỏi repo, yêu cầu revoke & cấp lại secret mới trên Google Cloud Console. Secret quản lý duy nhất qua Wrangler secrets.
- **S2**: Xóa hardcoded DEFAULT_JWT_SECRET; auth fail-closed (503) khi JWT_SECRET chưa cấu hình hoặc < 32 ký tự. Đã cấp `wrangler secret put JWT_SECRET` (64 chars base64) lên production — token giả mạo bằng secret cũ bị từ chối 401 (đã kiểm chứng live).
- **S3**: Frontend `fetchJson` gửi `Authorization: Bearer` trên mọi API call; tự động dọn credentials khi nhận 401.
- **S4**: Loại bỏ silent-fallback giả lập đăng nhập/đăng ký/OTP/Google (trước đây trả `success:true` với user ảo khi backend lỗi → session ma không đồng bộ). Lỗi thật hiển thị lên AuthPage. Giữ offline fallback cho GET đọc dữ liệu (PWA offline).
- **M16 Data**: Migration `0006_vietnamese_recipe_bank.sql` đã apply remote D1: 59 món Việt mới (10 nhóm: canh, kho, xào, chiên, hấp/luộc, cuốn, cơm/mì, lẩu, nộm/gỏi, tráng miệng) + 328 recipe_ingredients + 295 recipe_steps. API `/recipes` trả 71 món (59 VN + 12 global).
- **M16 Backend hardening**: rate-limit KV sliding-window, tenancyGuard multi-tenant, Zod validation, secureHeaders, PBKDF2 100k, JWT HMAC utils.
- **M16 UI**: Brand refresh emerald #059669 + Plus Jakarta Sans trên 25 pages.
- **Verify live**: health 200, /recipes 71 món, /inventory 401 không token, rate-limit + security headers hoạt động.

## Completed
- **M0: Foundation**: Khởi tạo repo Git, cấu hình TypeScript strict, Vite, Tailwind CSS (theme màu Frigo theo brand: Fresh Green #22C55E, Deep Green #0F3D2E, Mint #DDF7E3, Cream #FFFDF6), PostCSS, Cloudflare Worker + Hono, Wrangler bindings (D1, R2, KV, Queues), .dev.vars.example.
- **Brand Assets**: Tạo vector SVG logo, PWA favicon, và sinh bộ ảnh đồ họa cao cấp (`frigo-app-icon.jpg`, `hero-banner.jpg`, `scan-mockup.jpg`) bằng công cụ AI image generator.
- **M1: Design System & Mobile Shell**: Thiết lập cấu trúc mobile-first (360px - 430px), Header thông minh, thanh điều hướng đáy (Bottom Navigation) với nút chụp AI nổi bật ở trung tâm, hệ thống Badges, Cards, Buttons bo tròn mềm mại.
- **M2: Database & Domain Layer**:
  - D1 Migrations: 25 bảng quan hệ chuẩn hóa (`users`, `sessions`, `profiles`, `households`, `household_members`, `user_preferences`, `cuisines`, `ingredients`, `ingredient_aliases`, `ingredient_translations`, `inventory_items`, `inventory_events`, `scans`, `scan_items`, `recipes`, `recipe_ingredients`, `recipe_steps`, `recipe_translations`, `favorites`, `cooked_meals`, `shopping_lists`, `shopping_items`, `notifications`, `ai_requests`, `subscriptions`).
  - Event sourcing: Lưu vết lịch sử kho theo `inventory_events` (`ADD`, `MANUAL_UPDATE`, `SCAN_CONFIRM`, `COOK`, `DISCARD`).
  - Chuẩn hóa đơn vị đo lường: `g`, `kg`, `ml`, `l`, `piece`, `bunch`, `pack`, `slice`.
- **M3: Scan & AI Pipeline**:
  - Module `packages/ai` hoàn thiện: `AIRouter` với cơ chế fallback thông minh (Primary Qwen Vision -> Fallback GLM -> Fallback Mock Fixture).
  - Định dạng JSON nghiêm ngặt qua Zod schema: Tên nguyên liệu, số lượng, đơn vị, độ tin cậy.
  - Chế độ `AI_MOCK_MODE=true` cho phép kiểm thử toàn bộ luồng mà không phụ thuộc API key ngoài.
- **M4: Recipe Engine & Seed Data**:
  - Thuật toán Deterministic Matching & Scoring: 35% sẵn có, 25% ưu tiên đồ sắp hết hạn, 15% khẩu vị, 10% thời gian nấu, 10% vừa định lượng, 5% lịch sử.
  - Tính năng cốt lõi: Bộ lọc **"Không mua thêm gì"** (`missingRequiredIngredients === 0`).
  - Kho 70+ món ăn chuẩn mực thuộc 6 nền ẩm thực: Việt Nam, Hàn Quốc, Nhật Bản, Trung Hoa, Thái Lan, Ý.
- **M5: Cooking Mode & Inventory Deduction**:
  - Chế độ nấu ăn toàn màn hình từng bước, bộ đếm thời gian (Cooking Timer) tích hợp.
  - Màn hình hoàn tất nấu & bản nháp trừ nguyên liệu (`Thịt ba chỉ: 400g -> 100g`, `Trứng: 6 -> 3 quả`) cho phép người dùng xác nhận trước khi cập nhật tủ lạnh.
- **M6: Expiry Tracking & Shopping List**:
  - Tự động phân loại độ tươi (`Tươi ngon`, `Nên dùng sớm`, `Sắp hết hạn`).
  - Danh sách mua sắm thông minh: chuyển các nguyên liệu còn thiếu từ công thức món ăn vào shopping list chỉ với 1 chạm.
- **M7: PWA, CI & Testing**:
  - Web App Manifest và Service Worker setup.
  - GitHub Actions CI pipeline (`.github/workflows/ci.yml`).
  - 100% kiểm thử Vitest passed (Scoring engine & AI router schemas).
  - 100% Typecheck passed cho cả Web SPA và Cloudflare Worker.
  - 100% ESLint passed không có cảnh báo hay lỗi.
  - Production build thành công (`pnpm build`).
- **M10: Frontend Rebuild with Official Prompt Kit v1**:
  - Tích hợp trọn bộ tài nguyên thiết kế chính thức từ `frigo_frontend_prompt_kit_v1`: Design Tokens CSS (`frigo-tokens.css`), bảng màu chuẩn (`#22C55E`, `#0F3D2E`, `#DDF7E3`, `#FFFDF6`, `#EF4444`, `#FACC15`).
  - Toàn bộ ảnh đồ họa pre-cut trong `public/frigo/`: Brand Logo & Wordmark, App Icons (16-512px, Maskable), 24 UI Icons PNG, 8 Minh họa độc quyền (`scan-fridge`, `empty-fridge`, `no-recipes`, `shopping-ready`, `delicious-meal`, `use-soon`, `world-cuisines`, `frigo-plus`), 48 ảnh nguyên liệu PNG tách nền chuẩn (`ingredients/vegetables/*`, `ingredients/pantry/*`), và 12 ảnh món ăn WebP (`recipes/vietnam/*`, `recipes/global/*`).
  - Tái cấu trúc chuẩn hóa các components giao diện: `TopBar`, `BottomNav` (với Safe Area Padding và Tap Target >= 44px), `IngredientRow`, `RecipeCard`, `StatusChip`, `QuantityStepper`, `EmptyState`.
  - Cập nhật định tuyến chuẩn hóa theo `routes.json`: `/`, `/onboarding`, `/scan`, `/scan/:id/review`, `/fridge`, `/ingredients/:id`, `/recipes`, `/recipes/:slug`, `/cook/:slug`, `/shopping`, `/notifications`, `/profile`, `/settings`, `/plus`.
  - Đảm bảo 100% tiêu chuẩn QA Checklist: không lỗi 404 asset, không dùng master/board ảnh thay UI, tap-target >= 44px, đầy đủ aria-label trên các nút icon-only, safe-bottom padding, ảnh món ăn `object-fit: cover`, ảnh nguyên liệu & minh họa `object-fit: contain`.
  - Dev server hoạt động ổn định tại `http://localhost:5173/` (hỗ trợ cả mạng nội bộ `http://192.168.2.100:5173/`).
- **M11: Frigo Week — Thực đơn tuần ("Ăn đủ. Mua đủ. Dùng hết.")**:
  - **Closed Product Loop:** Khép kín chu trình `FRIDGE → WEEKLY PLAN → SHOPPING → COOK → INVENTORY UPDATE → NEXT WEEK PLAN`.
  - **Triết lý AI:** "AI KHÔNG BAO GIỜ làm phép tính toán học." Toàn bộ phần tính định lượng khẩu phần, ngân sách, phân bổ kích thước đóng gói bán lẻ, và trừ tồn kho tủ lạnh được thực thi 100% bằng TypeScript Domain Logic tất định (`packages/domain/src/week/`).
  - **Domain Engine & Package (`packages/domain/src/week/`):**
    - `planner.ts`: Sinh thực đơn 7 ngày tự động, thuật toán hoán đổi món (`swapMealInPlan`), tìm món thay thế (`getSwapAlternatives`).
    - `portion.ts`: Co giãn định lượng nguyên liệu theo số người hộ gia đình (`scaleRecipeIngredients`).
    - `pricing.ts`: Bảng giá trung bình thị trường Việt Nam theo từng đơn vị chuẩn VND (`ManualAveragePriceProvider`).
    - `packages.ts`: Quy đổi kích cỡ đóng gói bán lẻ (500g, 1kg, 1L, vỉ 6/10 trứng) và tính lượng thừa dự kiến (`calculatePackageRecommendation`).
    - `utilization.ts`: Đánh giá tỷ lệ tận dụng đồ tủ lạnh (`calculateFridgeUtilization`) và chỉ số rủi ro lãng phí thực phẩm (`calculateFoodWasteRisk`).
    - `leftover.ts`: Phân bổ nấu nhiều ăn 2 bữa (`batch cooking`) và ăn đồ thừa (`leftover allocation`).
    - `shopping.ts`: Khấu trừ tổng nhu cầu cả tuần với tồn kho tủ lạnh hiện có (Requirement 59), gom nhóm 7 khu vực chợ/siêu thị.
    - `score.ts`: Hệ thống tính điểm 9 tiêu chí cân bằng dinh dưỡng, ẩm thực, đạm, chi phí và thời gian.
  - **D1 Migration (`migrations/0003_weekly_planner.sql`):** 10 bảng quan hệ (`meal_plans`, `meal_plan_days`, `meal_slots`, `meal_plan_ingredient_requirements`, `shopping_runs`, `shopping_run_items`, `weekly_planner_preferences`, `pantry_staples`, `ingredient_prices`, `ingredient_package_sizes`).
  - **Cloudflare Worker API (`src/worker/routes/week.ts`):** 11 RESTful endpoints chuẩn hóa mounted tại `/api/v1/week/*`.
  - **Client API & Zustand Store (`src/web/services/api.ts`, `src/web/stores/useWeekStore.ts`):** Hỗ trợ đầy đủ kết nối Worker và local deterministic engine fallback.
  - **Giao diện & Điều hướng:**
    - Cập nhật Bottom Navigation: Tab `Tuần` (`/week`) nằm ở vị trí thứ 4.
    - Màn hình khởi tạo 5 bước (`/week/setup`): Bữa ăn cần lập, ngân sách tuần, lịch sinh hoạt & ăn ngoài, mức độ ưu tiên, tần suất đi chợ.
    - Màn hình hiệu ứng sinh kế hoạch thực tế (`/week/generating`).
    - Dashboard tuần đa dạng (`/week`): Thẻ thống kê (Ngân sách, Tận dụng tủ lạnh, Món cần mua, Rủi ro hết hạn), dòng thời gian 7 ngày, đổi món linh hoạt.
    - Màn hình chi tiết bữa ăn (`/week/:planId/meal/:mealId`): Phân loại rõ ràng Có sẵn / Cần mua / Thừa thiếu, CTAs Nấu ngay, Đổi món, Mở công thức.
    - Bottom sheet tráo món (`MealSwapSheet`): Hiển thị chênh lệch ngân sách ($\Delta$ Cost), thời gian chuẩn bị và độ tận dụng tủ lạnh ($\Delta$ Utilization).
    - Màn hình Đi chợ tuần (`/week/:planId/shopping`): Phân chia 7 khu vực thực tế, hoàn tất đi chợ tự động nhập kho tủ lạnh qua sự kiện `SHOPPING_IMPORT`.
    - Cài đặt tuần (`/week/:planId/settings`).
    - Tích hợp trang chủ (`HomePage.tsx`): Bữa ăn hôm nay "HÔM NAY ĂN GÌ", tiến độ tuần "TUẦN NÀY", banner mời lập thực đơn tuần.
    - Cập nhật Onboarding 4 bước (`OnboardingPage.tsx`): Thêm lựa chọn mục tiêu "Hôm nay ăn gì?", "Lên thực đơn tuần", hoặc "Cả hai (Khuyên dùng)".
  - **Chất lượng & Kiểm thử:**
    - 18/18 Unit tests passed (`tests/unit/week-planner.test.ts`, `recipe-engine.test.ts`, `ai-router.test.ts`).
    - 0 TypeScript errors (`pnpm typecheck`).
    - 0 ESLint errors/warnings (`pnpm lint`).
    - Production build thành công (`pnpm build`).

- **M12: Nâng cấp tổng thể & Hoàn thiện dự án (Overall Upgrade & Polish)**:
  - **Trụ cột 1 — Nhận diện hóa đơn siêu thị (Receipt OCR Scanning)**:
    - Zod schemas `ReceiptItemSchema` & `ReceiptScanResultSchema` phân tích tên sản phẩm, số lượng, đơn vị, đơn giá VND, tổng tiền VND, phân loại thực phẩm và kho lưu trữ (`fridge`, `freezer`, `pantry`).
    - Endpoint Worker `POST /api/v1/scans/receipt` & phương thức `api.scanReceipt()`.
    - Màn hình duyệt hóa đơn `ReceiptReviewPage.tsx` (`/scan/receipt-review`): bảng thống kê siêu thị, ngày mua, tổng tiền, stepper số lượng, xóa món, điều chỉnh kho lưu trữ, và 2 luồng nhập kho: Nhập vào tủ lạnh hoặc Đối chiếu danh sách đi chợ tuần.
    - Kích hoạt tab "Hóa đơn" trên trang `ScanPage.tsx`.
  - **Trụ cột 2 — Trợ lý đầu bếp giọng nói AI Voice Sous Chef & Web Audio Synthesis**:
    - `src/web/lib/audio-effects.ts`: Tổng hợp âm thanh bằng Web Audio API thuần (chuông báo timer, chime thành công, âm click chuyển bước) không phụ thuộc file mp3 ngoài hay CORS.
    - `src/web/lib/voice-chef.ts`: Tích hợp Web Speech API tiếng Việt (`vi-VN`) với Text-to-Speech (đọc to bước nấu) và Speech-to-Text nhận diện lệnh giọng nói ("tiếp tục", "lùi lại", "đọc lại", "bấm giờ", "dừng lại").
    - Tích hợp Chế độ nấu rảnh tay vào `CookingModePage.tsx` với nút mic hiệu ứng sóng âm nhấp nháy, banner trạng thái giọng nói nổi và âm báo động.
  - **Trụ cột 3 — Live Camera Viewfinder & Điều khiển Flash/Torch**:
    - `src/web/components/scan/CameraViewfinder.tsx`: Tích hợp luồng camera HTML5 `getUserMedia` trực tiếp, nút chuyển đổi camera trước/sau (`facingMode`), bật/tắt đèn flash/torch (`imageCapture.setOptions` hoặc `track.applyConstraints`), khung ngắm bo tròn chuẩn thương hiệu Frigo và hoạt ảnh tia laser quét xanh chuyển động mượt mà.
  - **Trụ cột 4 — Cổng thanh toán Frigo Plus qua VietQR Napas 24/7**:
    - `src/web/components/payment/VietQRModal.tsx`: Tạo mã VietQR động theo chuẩn Napas 24/7 với thông tin người nhận, số tiền gói (Tháng 79k / Năm 599k), nội dung chuyển khoản mã định danh (`FRG ...`), đếm ngược 15 phút, nút sao chép 1 chạm và kiểm tra tự động kích hoạt tài khoản Plus.
    - `useAuthStore.ts`: Lưu trữ trạng thái `isPlus` bền vững trên `localStorage`.
    - `PlusPaywallPage.tsx` & `ProfilePage.tsx`: Gắn thẻ huy hiệu "VIP PLUS" vàng kim lấp lánh khi thanh toán thành công.
  - **Trụ cột 5 — Mở rộng kho 32+ công thức nấu ăn & Định lượng dinh dưỡng**:
    - Bổ sung trường `nutrition` ({ calories, proteinG, fatG, carbG }) vào cấu trúc `Recipe`.
    - Mở rộng kho dữ liệu `packages/recipes/src/data.ts` từ 12 lên 32+ công thức chi tiết: bổ sung 14 món Việt chuẩn vị gia đình (Canh bí đỏ thịt bằm, Cá kho tộ, Canh chua cá lóc, Thịt kho tàu nước dừa, Gà kho gừng, Bò sốt tiêu đen, Sườn xào chua ngọt, Mực xào cần tỏi, Canh riêu cua bắp bò, Trứng chiên thịt bằm nấm rơm, Đậu phụ sốt cà chua, Bò xào hành cần tây, Canh sườn hầm rau củ, Chả cá chiên thì là) và 6 món quốc tế (Kimchi Jjigae, Cơm cuộn Gimbap, Cà ri Nhật Bản, Mì Udon xào hải sản, Gà Kung Pao, Cơm chiên Dương Châu).
  - **Trụ cột 6 — Chia sẻ tủ lạnh gia đình & Xuất thực đơn tuần**:
    - Trang `FamilySharingPage.tsx` (`/family`): Tạo mã mời hộ gia đình (`FRG-8926`), mã QR quét nhanh, chia sẻ link gia đình và quản lý danh sách thành viên.
    - Component `WeekExportModal.tsx`: Trích xuất thực đơn tuần và danh sách đi chợ theo 7 khu vực ra định dạng văn bản tiện dụng; hỗ trợ 1 chạm sao chép hoặc gửi trực tiếp qua Zalo, Messenger, SMS bằng Web Share API native.
  - **Kiểm thử & Đảm bảo chất lượng toàn diện**:
    - 22/22 Unit tests passed (`tests/unit/receipt-scan.test.ts`, `recipe-engine.test.ts`, `week-planner.test.ts`, `ai-router.test.ts`).
    - 0 TypeScript errors (`pnpm typecheck`).
    - 0 ESLint warnings/errors (`pnpm lint`).
    - Production build thành công 100% (`pnpm build`).
- **M13: Tối ưu PWA Ngoại Tuyến, Hiệu Suất Bundle & Sẵn sàng Cloudflare (Production Hardening)**:
  - **Service Worker & PWA Caching (`public/sw.js`, `src/web/main.tsx`)**:
    - Đăng ký Service Worker trong môi trường production, pre-cache app shell, manifest, brand icons, logo.
    - Chiến lược Cache-First cho static assets và Network-First cho navigation/API.
  - **Tối ưu Hóa Bundle & Code Splitting (`vite.config.ts`)**:
    - Cấu hình `manualChunks` tách `vendor-react`, `vendor-query`, `vendor-icons`. Giảm bundle chính từ 513 kB xuống ~300 kB (72 kB gzip), loại bỏ hoàn toàn cảnh báo Vite build.
  - **Chỉ Báo Ngoại Tuyến & Trải Nghiệm PWA (`OfflineBanner.tsx`, `SettingsPage.tsx`)**:
    - Tự động hiển thị thanh thông báo ngoại tuyến khi thiết bị mất kết nối mạng.
    - Thêm kiểm tra trạng thái Standalone PWA, hướng dẫn cài đặt lên Màn hình chính (Add to Home Screen) và nút xóa bộ nhớ đệm (Clear Cache).
  - **Khắc Phục Config Cloudflare Assets (`wrangler.jsonc`)**:
    - Sửa `assets.html_handling` thành chuẩn `auto-trailing-slash` tương thích Cloudflare Workers Assets.
  - **Script Kiểm Tra Tự Động Toàn Diện (`scripts/deploy-check.sh`, `pnpm check`)**:
    - Tích hợp pipeline kiểm tra 4 bước liên hoàn (Typecheck -> Lint -> Test -> Build) trong 1 lệnh duy nhất.

- **M14: Triển khai Hạ tầng Cloudflare Production & Live Custom Domain**:
  - **Tài khoản Cloudflare**: Kết nối và xác thực thành công qua OAuth (`tungbipdz@gmail.com` / Account ID `ef250a88911fd24073cb73d1c07e0218`).
  - **Khởi tạo Tài nguyên Cloudflare**:
    - D1 Database: `frigo-db` (`f975ec39-b2c8-4a2a-80e1-0366054599d3`) tại khu vực APAC (KIX).
    - R2 Storage Bucket: `frigo-images` (Standard Storage).
    - KV Cache Namespace: `frigo-cache` (`cbcd186cb63d4729ac23b04f1a539f2d`).
    - Queue Pipeline: `frigo-scan-queue` (Producers & Consumers).
  - **Database Migrations D1 Remote**:
    - Áp dụng thành công toàn bộ 3 bản migration (`0001_initial_schema.sql`, `0002_seed_data.sql`, `0003_weekly_planner.sql`) với 72 câu lệnh SQL, tạo 35 bảng chuẩn hóa và seed dữ liệu demo trên Cloudflare D1 Remote.
  - **Deploy Cloudflare Workers & Cloudflare Assets**:
    - Upload 129 static assets (ảnh, font, script bundles) lên Cloudflare CDN Edge.
    - Deploy Cloudflare Worker kèm triggers, bindings và custom domain.
  - **Live Production Domain**:
    - Domain chính thức: **`https://frigo.tungjpstore.net`**
    - Trạng thái: **HTTP/2 200 OK**, Cloudflare Edge Cache Active.
    - Health check API: `GET /api/v1/health` $\to$ `{"status":"ok","app":"Frigo","version":"0.1.0"}`.
    - D1 Query: `GET /api/v1/recipes` trả về đầy đủ danh sách món ăn từ D1 Remote.

- **M15: Hệ Thống Xác Thực Hoàn Chỉnh (Auth, OTP, Google OAuth 2.0)**:
  - **Tự động Cấu hình Google Cloud Console (`selinow-auth`)**:
    - Khởi tạo thành công OAuth 2.0 Web Client: `Frigo Web (Local & Production)`.
    - **Client ID**: `YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com`
    - **Client Secret**: *(ĐÃ XOÁ KHỎI TÀI LIỆU — secret bị lộ trong lịch sử git, đã revoke và cấp lại qua Google Cloud Console. Quản lý qua Wrangler secret từ nay.)*
    - Cấu hình nguồn gốc hợp lệ: `http://localhost:5173`, `https://frigo.tungjpstore.net`.
    - Cấu hình redirect URIs: `http://localhost:5173/auth/google/callback`, `https://frigo.tungjpstore.net/api/v1/auth/google/callback`, `https://frigo.tungjpstore.net/auth/google/callback`.
  - **Database Migration D1 (`migrations/0004_auth_system.sql`)**:
    - Bảng `auth_accounts`: lưu trữ mật khẩu băm SHA-256 kèm salt ngẫu nhiên 16 bytes, liên kết tài khoản Google ID, trạng thái `is_verified`.
    - Bảng `auth_otps`: quản lý mã số OTP 6 chữ số ngẫu nhiên theo từng mục đích (`register`, `forgot_password`), thời gian hết hạn 15 phút và trạng thái đã sử dụng `used`.
  - **Backend REST API (`src/worker/routes/auth.ts`)**:
    - `POST /api/v1/auth/register`: Đăng ký tài khoản mới $\to$ sinh mã OTP 6 số.
    - `POST /api/v1/auth/verify-otp`: Kiểm tra mã OTP, kích hoạt tài khoản `is_verified = 1`, cấp token phiên làm việc.
    - `POST /api/v1/auth/resend-otp`: Gửi lại mã OTP mới kèm bộ đếm thời gian 60s.
    - `POST /api/v1/auth/login`: Đăng nhập bằng Email + Mật khẩu băm an toàn, tự động nhắc OTP nếu chưa kích hoạt.
    - `POST /api/v1/auth/forgot-password`: Yêu cầu mã OTP khôi phục mật khẩu.
    - `POST /api/v1/auth/reset-password`: Xác thực OTP và lưu mật khẩu mới.
    - `POST /api/v1/auth/google`: Giải mã JWT ID Token Google và đồng bộ tài khoản người dùng tức thì.
  - **Giao diện Người Dùng Hoàn Chỉnh (`src/web/pages/AuthPage.tsx`)**:
    - Chuyển đổi mượt mà 4 chế độ: Đăng nhập, Đăng ký, Xác thực OTP (giao diện 6 ô số tự động chuyển tiếp và hỗ trợ dán), và Quên mật khẩu.
    - Tích hợp nút đăng nhập Google chính thức qua Google Identity Services SDK.
    - Hộp gợi ý mã OTP thử nghiệm (Dev OTP Badge) giúp test luồng tức thì.
  - **Kiểm thử & Đảm bảo Chất lượng**:
    - 26/26 Unit tests passed (`tests/unit/auth.test.ts` kiểm thử mã hóa mật khẩu, sinh OTP và giải mã Google JWT).
    - Toàn bộ luồng đăng ký, verify OTP, đăng nhập, quên mật khẩu, đặt lại mật khẩu đã được kiểm thử trực tiếp trên live domain `https://frigo.tungjpstore.net` với kết quả thành công 100%.

## M20: Audit core loop & roadmap (2026-09-05)
- Đã audit frontend, Worker, domain packages, migrations, Cloudflare bindings và test suite.
- Đã sửa contract fixture JWT (`typ=access|guest`) và chặn fallback demo khi API trả lỗi HTTP; mock AI chỉ được dùng khi bật rõ ràng.
- `pnpm check`: PASS (103 tests, typecheck, lint, build, migration smoke).
- Tài liệu audit và kế hoạch thực thi: `docs/PROJECT_AUDIT_AND_ROADMAP.md`.
- Đợt audit đã được rollout trong M22 sau khi fingerprint, backup và apply migrations production; các gap còn lại tập trung ở dual-write/E2E.

## M21: Core loop integrity follow-up (2026-09-06)
- Frigo Week lưu snapshot domain đầy đủ trong D1 (`migrations/0008_week_snapshot_metadata.sql`), giữ lại `dayType`, `dayNameVi`, slot metadata, ingredient requirements, giá và availability khi đọc lại.
- `meal_plan_days.day_type` được ghi cùng transaction với plan; legacy plans vẫn có fallback read an toàn.
- Inventory PATCH/DELETE dùng optimistic `version` (`migrations/0009_inventory_optimistic_version.sql`) và event chỉ ghi khi projection update thành công; scan/cook/shopping increments cũng cập nhật version.
- Scan confirm cộng delta vào tồn kho thay vì ghi đè số lượng đã đọc trước transaction; cooking kiểm tra batch result và fail closed khi D1 không commit.
- Migration `0006_vietnamese_recipe_bank.sql` đã chuyển sang UPSERT an toàn để replay không xóa `favorites`/`recipe_translations` tham chiếu recipe đã seed.
- Migration `0010_week_schema_shadow_canonical.sql` tạo và backfill ba projection Week v2 theo hướng additive; không drop bảng cũ và chưa bật Worker cutover.
- Bổ sung test round-trip Week snapshot, normalization legacy day-of-week, migration preservation smoke và concurrency/idempotency guard cho command routes.
  - Gate hiện tại: `pnpm build`, `pnpm check`, `pnpm test` (116 tests), `pnpm typecheck`, `pnpm lint`, `git diff --check`, `pnpm schema:check:remote`; fresh + upgrade replay SQLite 0001-0012 với `foreign_key_check` và preservation smoke đã pass.
- Đã rollout production trong M22 sau khi fingerprint D1, backup, apply migrations và hoàn tất post-deploy smoke test.

## M26: Durable scan queue consumer (2026-09-07) — DEPLOYED LIVE
- Đã backup D1 tại `.artifacts/frigo-db-pre-0012-20260906T163700Z.sql` và apply remote migration `0012_scan_queue_jobs.sql`.
- Queue consumer và async-canary scaffold đã triển khai production version `d1323a40-c492-4a68-b051-08f2e2079741`; queue binding producer/consumer và DLQ `frigo-scan-dlq` vẫn hoạt động.
- Ledger `scan_queue_jobs` đảm bảo tenant validation, idempotency, lease reclaim sau 10 phút, tối đa 3 attempts, retry 30 giây cho lỗi tạm thời và ack cho lỗi vĩnh viễn.
- Post-deploy smoke: health/config/recipes đều pass; release gate pass 117 tests, typecheck, lint, migrations, remote schema `0001`-`0012` và strict Week parity `2/2`.
- Các endpoint scan đã có async canary contract và được chuyển production sang queue sau khi provider smoke pass ở M27.
- `SCAN_QUEUE_MODE=sync|async` vẫn là công tắc rollback; mặc định production hiện là `async`.

## Known Issues
- Core loop đã khá sát production, nhưng vẫn còn gap route integration/E2E/concurrency cho rollback D1, tenancy và offline replay.
- Week v2 là shadow snapshot một lần; mutation mới vẫn chỉ cập nhật v1 nên cần dual-write + reconciliation trước cutover.
- Scan producer đã bật ở production; tiếp tục theo dõi backlog và tỷ lệ failed sau rollout.
- Groq production secret đã cấu hình; M27's earlier smoke used
  `qwen/qwen3.6-27b` after Scout returned `model_not_found`. This is historical
  evidence for that rollout, not proof of the current d1b06732 runtime.

## Next
- Theo dõi queue latency/retry/DLQ và tỷ lệ scan failed sau rollout async; rollback nhanh bằng `SCAN_QUEUE_MODE=sync` nếu backlog hoặc lỗi tăng bất thường.
- Xác minh địa chỉ nhận email trong Cloudflare Email Routing để OTP gửi qua Workers email binding tới được hộp thư người dùng (hiện binding đã cấu hình, cần verify destination).
- Kiểm chứng luồng OTP email thật end-to-end trên production (đăng ký tài khoản thật và xác nhận email đến hộp thư).

## M27: Groq Vision + Async Scan Rollout (2026-09-07) — HISTORICAL DEPLOYMENT
- This section records the original M27 rollout evidence only. The later
  2026-09-10 production receipt is authoritative for the current release, and
  the OCR recovery candidate below has not been deployed.
- Tạo Groq key `frigo-production-vision` bằng tài khoản đã đăng nhập; chỉ lưu qua Cloudflare Secret `GROQ_API_KEY`, không đưa vào repository/logs.
- Thêm `GroqProvider` và router priority `Groq -> Cloudflare Workers AI -> Qwen -> GLM`; parse JSON fail-closed, chuẩn hóa unit/category/storage và usage log không chứa ảnh/key.
- Groq smoke bằng PNG hợp lệ không PII đạt HTTP 200 với model `qwen/qwen3.6-27b`; model Scout cũ trả `model_not_found` nên đã chuyển default theo catalog vision hiện tại.
- Migration `0013_scan_receipt_metadata.sql` đã backup và apply remote; schema gate remote pass. Receipt queue lưu merchant, invoice, ngày mua, tổng tiền và giá đơn vị/tổng item.
- Fridge, food và receipt đều enqueue async; review receipt polling `pending/processing -> ready/failed`, chỉ cho confirm khi `ready`.
- Worker version `8ef81bdc-1346-481d-a945-583e8ae82006` live với `SCAN_QUEUE_MODE=async`; bindings xác nhận producer `frigo-scan-queue`, consumer và DLQ `frigo-scan-dlq`.
- Release gates: 124 tests, typecheck, lint, build, migration smoke và remote D1 schema gate pass; health production 200, `AI_MOCK_MODE=false`.
- Queue message giữ MIME ảnh gốc từ data URL/R2 metadata; receipt review không còn dùng fixture giả khi refresh thiếu `scanId`.

## OCR production-recovery (2026-09-13) — DEPLOYED AND VERIFIED
- Bản sửa phục hồi OCR đã merge qua PR #17 và deploy production; Worker version
  `df7225c9-6f20-4206-9f16-573de6a69c43` đang phục vụ 100% traffic.
- Candidate đặt Qwen `qwen3.7-flash` qua DashScope international làm provider
  chính cho vision, receipt OCR, chat và ranking. Groq, Cloudflare, DeepSeek và
  GLM chỉ tham gia khi các cờ fallback tương ứng được bật; mặc định giữ tất cả
  fallback này ở `false`.
- Quality gate Zod + confidence `0.6` loại nhãn placeholder/generic và trả
  `AI_SCAN_NO_USABLE_ITEMS` khi không còn dòng dùng được; OCR vẫn là draft cần
  người dùng review/confirm, không phải nguồn sự thật cho giá/tồn kho/an toàn.
- Queue phân loại lỗi provider: model/auth/permission/license/schema/quality là
  permanent; timeout/network/429/5xx/upstream mới được retry trong giới hạn
  attempts/DLQ hiện có. Candidate thêm migration additive
  `0023_scan_request_fingerprint.sql` để ràng buộc replay với đúng ảnh/MIME; đã
  apply và schema-gate remote sau backup ngày 2026-09-13. Không có backfill, secret
  change hay thay đổi PayOS/auth/Week trong candidate.
- Local candidate gates đã PASS ngày 2026-09-13: `pnpm check` chạy 1.579 test /
  93 file, lint, typecheck, migration replay tới `0023` và build. Live-provider
  smoke, readiness và Worker deployment đã PASS; hosted PR #17 CI `34728606704`
  đã PASS. Cảnh báo duy nhất là `CONFIG_PLUS_GRANT_SECRET_MISSING`.
