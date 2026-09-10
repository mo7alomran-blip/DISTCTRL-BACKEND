// اسم ملف عربي بـContent-Disposition يحتاج الاثنين معًا (RFC 6266): filename="..." (ASCII بسيط، fallback
// لأي عميل ما يدعم الترميز الموسّع) + filename*=UTF-8''... (الاسم العربي الحقيقي، RFC 5987). بدون الأول،
// بعض مسارات سفاري بالآيفون (تحديدًا "حفظ" ملف PDF مفتوح أصلاً بعارضه الداخلي، مو تنزيل مباشر) تتجاهل
// filename* كليًا وترجع لاسم عام مشتق من الرابط نفسه (اللي ينتهي بـ"/pdf" هنا، فيطلع اسم زي "pdf - pdf")
// — اكتُشف يوم 2026-09-10 عبر بلاغ مستخدم حقيقي.
export function contentDispositionInline(arabicFilename, asciiFallback) {
  const safeAscii = String(asciiFallback).replace(/[^\x20-\x7E]/g, "").replace(/[/\\:*?"<>|]/g, "").trim() || "document.pdf";
  return `inline; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(arabicFilename)}`;
}
