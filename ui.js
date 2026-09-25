const { InlineKeyboard } = require('grammy');

const STRINGS = {
  en: {
    portalWelcome: "🏛 <b>RENAISSANCE GLOBAL</b> | <i>Portal</i>\n━━━━━━━━━━━━━━━━━━━━\n\n<blockquote><b>Welcome to your secure academic gateway.</b>\nClear your tuition to unlock course modules and campus access.</blockquote>\n\n<b>⚡️ SYSTEM SEQUENCE:</b>\n<code>[1]</code> Select your academic department\n<code>[2]</code> Upload a pristine receipt photo\n<code>[3]</code> Obtain your official QR clearance\n\n👇 <i>Awaiting input...</i>",
    selectDept: "📚 <b>ACADEMIC PLACEMENT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Target your designated academic department below.</blockquote>",
    receiptReceived: "✅ <b>UPLOAD SECURED</b>\nYour document is securely queued. Monitor progress via <b>Track Status</b>.",
    sendReceiptPrompt: "✅ <b>TARGET:</b> <code>{dept}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n📸 <b>AWAITING MEDIA:</b> Transmit your receipt photo now.\n\n<blockquote><i>Note: Low-resolution or cropped images will be auto-rejected by the review team.</i></blockquote>",
    approvedMsg: "✅ <b>SYSTEM CLEARANCE APPROVED</b>\nYour tuition transaction has been verified by the Finance Office.",
    rejectedMsg: "❌ <b>CLEARANCE DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ERROR REASON:</b> {reason}</blockquote>\n\n{message}",
    pendingExists: "⚠️ <b>LOCKOUT: ACTIVE SUBMISSION</b>\n\nYou have a document currently under active staff review. Await resolution.",
    helpText: "❓ <b>SUPPORT DIRECTORY</b>\n\n<blockquote>For technical faults or payment discrepancies, report directly to the central Registrar Office.</blockquote>"
  },
  am: {
    portalWelcome: "🏛 <b>ሬነሳንስ ግሎባል</b> | <i>የተማሪ ፖርታል</i>\n━━━━━━━━━━━━━━━━━━━━\n\n<blockquote><b>እንኳን ወደ ተማሪዎች ማዕከል በሰላም መጡ።</b>\nሞጁሎችን ለማውረድ የክፍያዎን ሂደት ያጠናቅቁ።</blockquote>\n\n<b>⚡️ ዋና እርምጃዎች:</b>\n<code>[1]</code> የትምህርት ክፍልዎን ይምረጡ\n<code>[2]</code> ግልጽ የሆነ ደረሰኝ ፎቶ ይላኩ\n<code>[3]</code> ይፋዊ ማረጋገጫ (QR) ይቀበሉ\n\n👇 <i>ለመጀመር ከታች ይምረጡ፡</i>",
    selectDept: "📚 <b>የትምህርት ክፍል</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>እባክዎን ትምህርት ክፍልዎን ይምረጡ፡</blockquote>",
    receiptReceived: "✅ <b>ማመልከቻዎ ገብቷል</b>\nየላኩት ደረሰኝ ተመዝግቧል። 'ሁኔታውን እይ' በመጫን መከታተል ይችላሉ።",
    sendReceiptPrompt: "✅ <b>የተመረጠው ክፍል፡</b> <code>{dept}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n📸 <b>ቀጣይ እርምጃ፡</b> የክፍያ ደረሰኝ ፎቶዎን አሁን ይላኩ።\n\n<blockquote><i>ማሳሰቢያ፡ ብዥ ያለ ወይም የተቆረጠ ፎቶ ተቀባይነት የለውም።</i></blockquote>",
    approvedMsg: "✅ <b>ማረጋገጫዎ ጸድቋል</b>\nየክፍያ ማረጋገጫዎ በፋይናንስ ቢሮ ተቀባይነት አግኝቷል።",
    rejectedMsg: "❌ <b>ማመልከቻዎ ውድቅ ተደርጓል</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ምክንያት:</b> {reason}</blockquote>\n\n{message}",
    pendingExists: "⚠️ <b>በሂደት ላይ ያለ ማመልከቻ አለ</b>\n\nቀደም ሲል የላኩት ደረሰኝ በግምገማ ላይ ነው። መታየት እስኪያልቅ ይጠብቁ።",
    helpText: "❓ <b>የድጋፍ ማዕከል</b>\n\n<blockquote>በክፍያ ወይም በምዝገባ ላይ ችግር ካለዎት፣ እባክዎን የሬጅስትራር ቢሮውን ያነጋግሩ።</blockquote>"
  }
};

const REJECTION_REASONS = [
  { label: "📷 BLURRY/UNREADABLE MEDIA", code: "blurry", message_en: "Please ensure your receipt image is clear, fully visible, and uncropped.", message_am: "እባክዎን የደረሰኝዎ ፎቶ ግልጽ እና ሙሉ በሙሉ የሚታይ መሆኑን አረጋግተው እንደገና ይላኩ።" },
  { label: "💵 TRANSACTION AMOUNT MISMATCH", code: "amount", message_en: "The payment amount does not match your required tuition fees.", message_am: "የተከፈለው የገንዘብ መጠን ከተፈለገው የትምህርት ክፍያ ጋር አይመሳሰልም።" },
  { label: "🚫 INVALID/UNVERIFIED RECEIPT", code: "invalid", message_en: "This receipt could not be verified by our finance team. Please submit an official bank transaction receipt.", message_am: "ይህ ደረሰኝ ሊረጋገጥ አልቻለም። እባክዎን ኦፊሴላዊ የባንክ ደረሰኝ ይላኩ።" },
  { label: "👤 CREDENTIAL MISMATCH (NAME/ID)", code: "mismatch", message_en: "The name or Student ID on the receipt does not match your profile details.", message_am: "በደረሰኙ ላይ ያለው ስም ወይም የተማሪ መታወቂያ ከተመዘገበው መረጃ ጋር አይመሳሰልም።" }
];

function getDepartmentKeyboard() {
  return new InlineKeyboard()
    .text("📈 MARKETING", "dept_Marketing Management").text("💼 BUSINESS", "dept_Business Management").row()
    .text("📊 ACCOUNTING & FINANCE", "dept_Accounting and finance").row()
    .text("🌾 AGRIBUSINESS & VCM", "dept_Agribusiness and Value chain management").row()
    .text("📚 ED. PLANNING & MGMT", "dept_Educational planning and management").row()
    .text("🚚 LOGISTICS & SCM", "dept_Logistics and Supply chain management");
}

function getStaffKeyboard() {
  return new InlineKeyboard()
    .text('🟢 APPROVED DIRECTORY', 'cmd_approved_roster').text('🔍 SEARCH ID', 'cmd_lookfor').row()
    .text('📂 UPLOAD MODULE', 'cmd_upload_module').text('🗑 MANAGE VAULT', 'cmd_delete_module').row()
    .text('🔄 OVERRIDE DEPT', 'cmd_panel_changedept').text('⚠️ REVOKE STATUS', 'cmd_panel_revoke').row()
    .text('🚷 WIPE STUDENT', 'cmd_panel_wipe').text('⏳ SET DEADLINE', 'cmd_panel_deadline').row()
    .text('📊 LIVE ANALYTICS', 'cmd_stats').text('📈 VAULT STATS', 'cmd_mod_analytics').row()
    .text('📥 EXPORT DATABASE (CSV)', 'cmd_export').row()
    .text('🔓 OPEN NEW REGISTRATION', 'cmd_advance_term').row()
    .text('📢 BROADCAST SYSTEM ALERT', 'cmd_broadcast');
}

function getStudentKeyboard(status, userSeason, currentSeason, lang = 'en') {
  const kb = new InlineKeyboard();
  const isAm = lang === 'am';
  let effectiveStatus = status;
  
  if (effectiveStatus === 'APPROVED' && userSeason < currentSeason) effectiveStatus = null;

  if (effectiveStatus === 'WIPED') {
      kb.text(isAm ? '📤 አዲስ ምዝገባ ጀምር' : '📤 Start New Registration', 'cmd_submit');
      return kb;
  }
  
  if (effectiveStatus === 'PENDING') {
      kb.text(isAm ? '⏳ በግምገማ ላይ...' : '⏳ Review In Progress...', 'cmd_pending_info').row();
      kb.text(isAm ? '🛑 ማመልከቻ ሰርዝ' : '🛑 Cancel Pending Submission', 'cmd_cancel_pending');
  } else if (effectiveStatus === 'APPROVED') {
      kb.text(isAm ? '⬇️ የይለፍ ማረጋገጫ' : '⬇️ Download Clearance', 'cmd_download_pdf').row();
  } else {
      kb.text(isAm ? '📤 ደረሰኝ አስገባ' : '📤 Transmit Receipt', 'cmd_submit');
  }
  
  kb.text(isAm ? '📌 ሁኔታውን እይ' : '📌 Track Status', 'cmd_status').row();
  kb.text(isAm ? '📚 የትምህርት ሞጁሎች' : '📚 Access Vault', 'cmd_modules').row();
  kb.text(isAm ? '📜 የክፍያ ታሪክ' : '📜 Audit History', 'cmd_history').text(isAm ? '❓ እገዛ' : '❓ Get Support', 'cmd_help');
  return kb;
}

function getModuleDepartmentKeyboard() { return new InlineKeyboard().text("📈 MARKETING", "moddept_Marketing Management").text("💼 BUSINESS", "moddept_Business Management").row().text("📊 ACCOUNTING & FINANCE", "moddept_Accounting and finance").row().text("🌾 AGRIBUSINESS", "moddept_Agribusiness and Value chain management").row().text("📚 ED. PLANNING", "moddept_Educational planning and management").row().text("🚚 LOGISTICS", "moddept_Logistics and Supply chain management").row().text("🔙 CANCEL", "moddept_cancel"); }
function getDeleteModuleDepartmentKeyboard() { return new InlineKeyboard().text("📈 MARKETING", "delmoddept_Marketing Management").text("💼 BUSINESS", "delmoddept_Business Management").row().text("📊 ACCOUNTING & FINANCE", "delmoddept_Accounting and finance").row().text("🌾 AGRIBUSINESS", "delmoddept_Agribusiness and Value chain management").row().text("📚 ED. PLANNING", "delmoddept_Educational planning and management").row().text("🚚 LOGISTICS", "delmoddept_Logistics and Supply chain management").row().text("🔙 CANCEL", "delmoddept_cancel"); }
function getApprovedRosterKeyboard() { return new InlineKeyboard().text("🌐 EVERY STUDENT", "roster_all").row().text("📈 MARKETING", "roster_Marketing Management").text("💼 BUSINESS", "roster_Business Management").row().text("📊 ACCOUNTING & FINANCE", "roster_Accounting and finance").row().text("🌾 AGRIBUSINESS", "roster_Agribusiness and Value chain management").row().text("📚 ED. PLANNING", "roster_Educational planning and management").row().text("🚚 LOGISTICS", "roster_Logistics and Supply chain management").row().text("🔙 CANCEL", "roster_cancel"); }
function getTransferKeyboard(userId, topicId) { return new InlineKeyboard().text("📈 MARKETING", `tr_${userId}_${topicId}_mkt`).text("💼 BUSINESS", `tr_${userId}_${topicId}_biz`).row().text("🌾 AGRIBUSINESS", `tr_${userId}_${topicId}_agri`).text("📚 ED. PLANNING", `tr_${userId}_${topicId}_ed`).row().text("📊 ACCOUNTING", `tr_${userId}_${topicId}_acc`).text("🚚 LOGISTICS", `tr_${userId}_${topicId}_log`).row().text("🔙 CANCEL TRANSFER", `canceltrans_${userId}_${topicId}`); }
function getRejectionReasonKeyboard(userId, topicId) { const kb = new InlineKeyboard(); REJECTION_REASONS.forEach((r) => kb.text(r.label, `confirmrej_${userId}_${topicId}_${r.code}`).row()); return kb; }

module.exports = { STRINGS, REJECTION_REASONS, getDepartmentKeyboard, getStaffKeyboard, getStudentKeyboard, getModuleDepartmentKeyboard, getDeleteModuleDepartmentKeyboard, getApprovedRosterKeyboard, getTransferKeyboard, getRejectionReasonKeyboard };