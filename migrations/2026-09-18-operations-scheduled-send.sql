-- وحدة "التشغيل" — جدولة وقت إرسال رسالة التشغيل (بدل الإرسال الفوري وقت الاستيراد)
ALTER TABLE operations ADD COLUMN scheduled_send_at DATETIME(3) NULL AFTER message_status;
