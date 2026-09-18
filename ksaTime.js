// تنسيق تاريخ/وقت بتوقيت السعودية (Asia/Riyadh، UTC+3 بدون توقيت صيفي) — أي نص تاريخ/وقت يُعرض للمستخدم
// (واتساب، PDF، بريد) لازم يمر من هنا، مو new Date(d).getHours() مباشرة. السبب: سيرفر الـVPS مضبوط على UTC
// (Etc/UTC)، فـgetHours()/getMinutes() ترجّع ساعة UTC الخام — كانت كل الأوقات المعروضة متأخرة 3 ساعات بالضبط
// عن التوقيت المحلي الفعلي (خلل حقيقي بلّغ عنه المستخدم يوم 2026-09-11: رسالة "تنبيه: عمل متأخر" عرضت وقت
// استلام مختلف عن الوقت الحقيقي اللي وصل فيه إشعار "تم استلام العمل" بنفس اللحظة على نفس الرقم).
const KSA_TZ = "Asia/Riyadh";

function ksaParts(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: KSA_TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  if (parts.hour === "24") parts.hour = "00"; // بعض تطبيقات Intl ترجّع "24" بدل "00" لمنتصف الليل
  return parts;
}

export function fmtKsaDateTime(d) {
  if (!d) return "—";
  const p = ksaParts(new Date(d));
  return `${p.day}/${p.month}/${p.year} - ${p.hour}:${p.minute}`;
}

export function fmtKsaDate(d) {
  if (!d) return "—";
  const p = ksaParts(new Date(d));
  return `${p.day}/${p.month}/${p.year}`;
}

export function todayKsaShort() {
  return fmtKsaDate(new Date());
}

// YYYY-MM-DD بتوقيت السعودية — للمقارنة مع أعمدة DATE (scheduled_date) ولأسماء ملفات النسخ الاحتياطي.
// new Date().toISOString().slice(0,10) كان يرجّع تاريخ UTC الخام — يوم مختلف عن الفعلي بين الساعة 00:00
// و03:00 بتوقيت السعودية (لأن UTC لسه باليوم اللي قبله بهالنافذة الزمنية).
export function todayKsaISO() {
  const p = ksaParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}
