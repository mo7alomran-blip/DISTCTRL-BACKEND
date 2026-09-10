-- بيانات إعداد حقيقية (مو هيكلة) — قيم report_schedules الفعلية بقاعدة Postgres الرئيسية (الإنتاج) وقت
-- الاستخراج (2026-08-28)، تُشغَّل مرة وحدة بعد schema.sql عند تهيئة قاعدة MySQL. بدونها cron.js ما يقدر
-- يجدول أي تقرير عند الإقلاع. ملاحظة: قيم الأسبوعي هنا مختلفة عن التجريبي فعليًا (يوم الأحد هنا مقابل
-- الثلاثاء بالتجريبي) — تحقّقنا منها كل بيئة لحالها، مو نسخ افتراض.
-- كل الأوقات بتوقيت السعودية — التحويل لـUTC يصير داخل cron.js.
INSERT INTO report_schedules (report_type, hour, minute, day_of_week, day_of_month, enabled) VALUES
  ('daily',   6, 0, NULL, NULL, 1),
  ('weekly',  7, 0, 0,    NULL, 1),
  ('monthly', 7, 0, NULL, 1,    1);
