# Nhật ký thay đổi — Deplao

## v26.11.4 (22/11/2026)

### Điểm nổi bật
- **Gộp bản cập nhật mới nhất từ Deplao gốc (`v26.11.2`)**: Thả cảm xúc kiểu mới cho Zalo & Telegram, kho sticker Zalo 50 bộ có sẵn + 182 bộ tải thêm miễn phí (gợi ý từ 1 ký tự), chiến dịch gửi video & tệp kèm tự gắn nhãn & biến `{gender}` / `{phone}`, chiến dịch Facebook & Messenger realtime, gửi album ảnh Telegram, màn hình chờ và khắc phục màn hình đen sau khi mở máy.
- **Sửa lỗi bấm vào Cài đặt → Tài khoản bị màn hình trắng**: Sửa vòng lặp render Zustand v5 trong `useAccountAutoDownloadState` và `useThreadAutoDownloadState` bằng `useShallow`.
- **Giữ trọn toàn bộ tính năng nâng cao**: Trợ lý AI toàn app với 28 công cụ (CRM, Phòng ban, Công việc, Báo cáo, khóa cứng chống xóa), Nhóm Nhiều AI (Phase 2), Phòng Liên Nền Tảng (Phase 3), lọc nhãn Zalo trong AI, tự động tải file 3 cấp và đồng bộ tắt thông báo Zalo.

### Chi tiết
- **Hợp nhất Deplao gốc v26.11.2**:
  - **Cảm xúc Zalo & Telegram**: Nút cảm xúc ở góc tin Zalo (giữ để chọn 👍 ❤️ 😆 😮 😭 😡, bấm `✕` để gỡ); cảm xúc Telegram hiển thị ngay trong khung tin, hỗ trợ nháy đúp thả nhanh và xem danh sách người thả.
  - **Kho sticker Zalo**: 50 bộ mở trực tiếp không cần tải trước, nút `+` thêm 182 bộ miễn phí, tìm và gợi ý từ 1 ký tự nhờ bảng từ khóa cục bộ.
  - **Chiến dịch & Kênh chat**: Đính kèm video/tệp khi gửi chiến dịch, tự gắn nhãn Local & Zalo cho người gửi thành công, thêm biến `{gender}` và `{phone}`; Facebook hỗ trợ chiến dịch nhắn tin và cập nhật bridge E2EE mới nhất; Telegram gửi/chuyển tiếp nhiều ảnh gộp thành 1 album (tối đa 10 ảnh).
  - **Trải nghiệm cửa sổ Windows**: Màn hình chờ sáng/tối khi khởi động hoặc tải lại, chống màn hình đen sau sleep/khóa máy.
- **Sửa lỗi**:
  - Sửa lỗi màn hình trắng khi mở **Cài đặt → Tài khoản** (hoặc bảng **Thông tin hội thoại**) do selector trả về object mới thiếu `useShallow` trên Zustand v5.

---

## v26.11.3 (18/11/2026)

### Điểm nổi bật
- **Nhóm Chat Nhiều AI Nội Bộ (Phase 2)**: Mời nhiều Trợ lý AI với chuyên môn khác nhau (Sales, CSKH, Kế toán, Quản trị dự án...) vào chung một phòng để cùng bàn bạc, phản biện và xử lý công việc.
- **Phòng Chat Liên Nền Tảng Người + AI + Zalo / Facebook / Telegram (Phase 3)**: Gom tin nhắn thời gian thực từ bất kỳ cuộc trò chuyện Zalo, Facebook Messenger, Telegram và Telegram Bot về chung 1 phòng họp có AI hỗ trợ.
- **An toàn chống lặp & chống khóa tài khoản**: Trang bị bộ lọc chống lặp tin nhắn 2 lớp, hàng đợi giãn cách riêng theo từng tài khoản và tùy chọn duyệt bán tự động trước khi phát ra ngoài.

### Tính năng mới
- **Tạo & cấu hình Nhóm Nhiều AI** ngay trong mục **Trợ lý AI**:
  - Đặt `@Alias` và mô tả vai trò/nhiệm vụ riêng cho từng AI tham gia nhóm.
  - Hỗ trợ 3 chế độ phối hợp: **`@mention`** (gọi đích danh AI hoặc AI Trưởng nhóm), **Thảo luận vòng tròn** (các AI trả lời nối tiếp, tham khảo ý kiến nhau tối đa 1–6 lượt) và **AI Điều phối** (AI Trưởng nhóm phân việc cho các chuyên gia rồi tổng hợp kết luận).
- **Phòng Chat Liên Nền Tảng (Bridge Room)**:
  - Kết nối đồng thời nhiều hội thoại 1-1 hoặc nhóm từ **Zalo**, **Facebook**, **Telegram** và **Telegram Bot** vào cùng một phòng.
  - Tùy chỉnh riêng từng nguồn: chiều đồng bộ (**Hai chiều**, **Chỉ nhận vào**, **Chỉ gửi ra**), chế độ (**Duyệt trước khi gửi** hoặc **Tự động chuyển tiếp**) và tùy chọn tự phát phản hồi của AI.
  - Tin nhắn từ khách hàng/nhóm bên ngoài hiển thị rõ nhãn kênh và tên nguồn; hỗ trợ bấm nút **Gọi AI phân tích / trả lời** hoặc **Phát câu trả lời ra Zalo / Facebook / Telegram** ngay tại từng tin nhắn.

### Cải thiện & An toàn
- Mỗi thành viên AI trong nhóm vẫn sử dụng đầy đủ bộ 28 Tool Calling theo đúng phân quyền riêng và giữ nguyên khóa cứng cấm xóa dữ liệu.
- Đồng bộ trạng thái tắt thông báo (Mute) từ Zalo về Deplao ngay khi kết nối hoặc chuyển tài khoản (giữ chuẩn trạng thái tắt theo giờ hoặc vô thời hạn từ điện thoại / Zalo PC).
- Chống lặp vô hạn 2 lớp (dấu vân tay tin nhắn + ID tin nhắn đã phát) và xếp hàng gửi qua `AccountSendQueue` để bảo vệ tài khoản khỏi bị đánh dấu spam.

---

## v26.11.2 (18/11/2026)

### Điểm nổi bật
- **Trợ lý AI toàn ứng dụng & Khung chat AI riêng**: Mở khung Trợ lý AI ở bất kỳ màn hình nào, hoặc vào không gian Trợ lý AI toàn màn hình; trượt thanh bên mượt mà, vùng chat tự co giãn không che khuất tin nhắn.
- **AI hỗ trợ quản lý trọn bộ Deplao**: Tạo và cập nhật Phòng ban, Chức vụ, Nhân sự, Dự án, Công việc, Checklist, Lịch hẹn, Ghi chú, Nhãn & Chiến dịch CRM, tra cứu POS và lập Báo cáo tiến độ công việc.
- **Phân quyền chi tiết từng Trợ lý AI & Khóa cứng quyền Xóa**: Chọn rõ quyền cho từng trợ lý (`Tắt` / `Chỉ đọc` / `Tạo, Đọc & Sửa`); hệ thống chặn tuyệt đối mọi thao tác xóa dữ liệu.
- **Bộ lọc thông minh tới 1.000 tin nhắn (cả Nhãn Zalo & Nhãn Deplao)**: Lọc nhanh theo thời gian, hội thoại, cá nhân 1-1 hay nhóm, người gửi, từ khóa và mọi loại nhãn để AI phân tích chính xác.
- **Chủ động kiểm soát tải file đính kèm 3 cấp độ**: Tùy chọn bật/tắt tự động tải file cho toàn phần mềm, từng tài khoản hoặc từng cuộc trò chuyện.

---

### Tính năng mới
- **Chat với Trợ lý AI mọi lúc mọi nơi**: Bấm nút **AI** trên thanh công cụ trên cùng để dùng ngay ở mọi màn hình, hoặc mở trang **Trợ lý AI** riêng trên thanh menu bên trái.
- **Bộ lọc ngữ cảnh đa chiều (tối đa 1.000 tin nhắn)**:
  - Lọc theo khoảng thời gian (`Hôm nay`, `Hôm qua`, `7 ngày`, `30 ngày` hoặc khoảng ngày tự chọn).
  - Chọn một, nhiều hoặc tất cả hội thoại; phân loại chat **1-1** hay **Nhóm**.
  - Chọn một hoặc nhiều **người gửi**, tìm kiếm theo **từ khóa** nội dung.
  - Lọc đồng bộ theo cả **Nhãn Deplao**, **Tag CRM** và **Nhãn gốc trên Zalo** (có nút cập nhật danh sách nhãn).
- **Bộ công cụ hành động AI (Chỉ Tạo, Đọc & Sửa)**:
  - **Phòng ban & Nhân sự**: Xem sơ đồ tổ chức, chấm công, đơn nghỉ phép; tạo/cập nhật hàng loạt phòng ban, chức vụ, hồ sơ nhân sự, tạo/duyệt đơn nghỉ phép.
  - **Dự án & Công việc**: Xem và tạo/cập nhật dự án, công việc, checklist, bình luận, hạn hoàn thành, giao việc.
  - **Lịch hẹn & Ghi chú**: Tạo/dời lịch hẹn trên Lịch ERP; tạo/cập nhật ghi chú và thư mục tài liệu.
  - **Tóm tắt & Báo cáo công việc**: Thống kê công việc theo trạng thái, việc quá hạn, việc sắp đến hạn, năng suất theo nhân sự/phòng ban/dự án và hoạt động tin nhắn/CRM.
  - **CRM & Hội thoại**: Tra cứu & cập nhật thông tin khách hàng, thêm/sửa ghi chú CRM, tạo/gắn nhãn, lưu bản nháp chiến dịch CRM (không tự ý gửi hàng loạt), soạn tin nhắn gửi khách (chờ xác nhận).
- **Bảng phân quyền khi tạo/sửa Trợ lý AI**:
  - Thiết lập độc lập mức quyền (`Tắt`, `Chỉ đọc`, `Tạo, Đọc & Sửa`) cho 7 nhóm tính năng.
  - Có sẵn 5 nút chọn nhanh theo vai trò: `Toàn quyền (Tạo, Đọc, Sửa)`, `Chỉ đọc & Báo cáo`, `CSKH & CRM`, `Quản trị Tổ chức & Công việc`, `Tắt tất cả công cụ`.
- **Quản lý tự động tải file đính kèm 3 cấp độ**:
  - Cài đặt chung trong **Cài đặt → Lưu trữ**, ghi đè theo từng tài khoản trong **Cài đặt → Tài khoản**, hoặc cho từng cuộc trò chuyện/nhóm (bảng Thông tin hội thoại & menu chuột phải).
  - Khi tắt tự động tải, có thể bấm tải thủ công ngay trên từng tin nhắn chứa ảnh, video hoặc tệp.

### Cải thiện
- Khung chat ở giữa tự động co gọn mỗi khi mở thanh **Thông tin hội thoại** hoặc **Trợ lý AI**, không còn che mất nội dung tin nhắn; hỗ trợ kéo viền để đổi kích thước.
- Nội dung AI trả lời hỗ trợ Markdown đẹp mắt (bảng biểu, danh sách, tiêu đề, khối mẫu câu) và có nút **Xác nhận tất cả** khi AI đề xuất nhiều thao tác tạo/sửa cùng lúc.
- Khung **Chat thử** trong màn hình cấu hình Trợ lý AI có thêm chế độ **Trợ lý & Công cụ** để kiểm tra trực tiếp khả năng gọi công cụ theo quyền đã cấp.

### Sửa lỗi
- Khắc phục lỗi bộ lọc nhãn trong khung Trợ lý AI chỉ lọc được Nhãn Deplao mà bỏ sót các hội thoại gắn **Nhãn Zalo**.
- Khắc phục lỗi đồng bộ tin nhắn từ Zalo điện thoại (Mobile Sync) báo lỗi 404 sớm khi bản sao lưu đang được chuẩn bị.

### Bảo vệ dữ liệu & An toàn
- **Khóa cứng quyền XÓA đối với Trợ lý AI**: AI bị chặn hoàn toàn ở cả hướng dẫn hệ thống lẫn tầng xử lý backend — chỉ được phép **Tạo, Đọc, Sửa** trong đúng nhóm tính năng được cấp quyền và luôn có bước **Xác nhận** trước khi ghi thay đổi.
