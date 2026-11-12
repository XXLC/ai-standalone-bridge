# Mẫu hướng dẫn điều phối agent

Ba tệp trong thư mục này là khối quy tắc "làm việc cùng Codex, Gemini và DeepSeek" dùng cho các agent. Mỗi khối nằm giữa hai dòng thẻ HTML `<!-- dieu-phoi-agent:bat-dau -->` và `<!-- dieu-phoi-agent:ket-thuc -->`; chỉ chép phần giữa hai thẻ (gồm cả hai thẻ, để sau này thay lại được) vào tệp cấu hình cấp người dùng:

| Mẫu | Chép vào |
|---|---|
| `CLAUDE.template.md` | `<HOME>/.claude/CLAUDE.md` |
| `AGENTS.template.md` | `<HOME>/.codex/AGENTS.md` (Codex chỉ đọc `AGENTS.md`; phiên DeepSeek qua Codewhale cũng đọc được `AGENTS.md` ở thư mục project khi được dặn) |
| `GEMINI.template.md` | `<HOME>/.gemini/GEMINI.md` |

Các khối này là chính sách của một người dùng cụ thể, không phải chuẩn. Đọc và sửa cho đúng ý bạn trước khi dùng, nhất là:
- Các chỗ giữ chỗ: `<HOME>`, `<ĐƯỜNG_DẪN_AGY>` (đường dẫn tới `agy`), `<ĐƯỜNG_DẪN_CODEX>` (lệnh gọi `codex` nếu không có trong `PATH`), `<ĐƯỜNG_DẪN_CODEWHALE>` (lệnh gọi `codewhale` nếu không có trong `PATH`, ví dụ `& "$env:APPDATA\npm\codewhale.cmd"` trên Windows), `<slug>` (quy ước đặt tên thư mục memory của Claude Code).
- Lệnh và đường dẫn viết theo Windows và PowerShell (`codex exec`, `agy -p`, `codewhale exec`); các hệ điều hành khác chưa kiểm.
- Chính sách chọn model (hạng trung bình trở xuống, Gemini chủ yếu Flash) là ví dụ của một người dùng, dựa trên phân hạng ngày 12/11/2026 từ trang chính hãng và bài bên thứ ba (benchmark do chính hãng công bố, chưa đối chiếu độc lập), sẽ lỗi thời: sửa cho đúng nhu cầu và ngân sách của bạn. Tên model Gemini (`claude-sonnet-5-5-high`, `gemini-4-argon-*`, `gemini-3.8-flash-*`) lấy từ `agy models` của một tài khoản cụ thể; tên model DeepSeek (`deepseek-flash`, `deepseek-v4-pro`) theo cấu hình nhà cung cấp `deepseek` của Codewhale `0.10.2`. Hãy kiểm tra danh sách model trên máy của bạn.
- Danh sách "nhóm việc hạn chế" và việc cho Codex, Gemini, DeepSeek đọc memory của Claude: xem `docs/SECURITY.md` trước khi bật. Đọc memory nghĩa là nội dung đó đi tới máy chủ của OpenAI, Google và DeepSeek (`https://api.deepseek.com`).
- Từ khóa nhận biết "hết quota" và dấu hiệu hết tiền của DeepSeek (HTTP `402 Insufficient Balance`, `429`) là ước đoán ban đầu từ tài liệu, chưa được kiểm với thông báo lỗi thật khi cạn quota/tiền của từng dịch vụ.
- Antigravity cắt mỗi tệp hướng dẫn ở 24.000 byte; khối này khoảng 3 KB cho Codex/Gemini và khoảng 8 KB cho Claude.
