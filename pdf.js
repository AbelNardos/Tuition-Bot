const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

function cleanForPDF(str, fallbackStr = '') {
  if (!str) return fallbackStr;
  const cleaned = String(str).replace(/[^\x00-\x7F]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallbackStr;
}

async function generateApprovalPDF(userId, username, department, staffName, botUsername, lang = 'en', academic_year = 1, academic_semester = 1) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 0, size: 'A4', info: { Title: `Official Tuition Clearance - ${userId}` } });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const pw = doc.page.width; const ph = doc.page.height; const serialNum = `RG-CLR-${userId}-${Date.now().toString(36).toUpperCase()}`;

      doc.save(); doc.translate(pw / 2, ph / 2); doc.rotate(-45);
      doc.font('Helvetica-Bold').fontSize(48).fillColor('#000000').fillOpacity(0.04);
      doc.text('VERIFIED CLEARANCE • RENAISSANCE GLOBAL', -400, -50, { width: 800, align: 'center' });
      doc.restore(); 

      doc.rect(20, 20, pw - 40, ph - 40).lineWidth(4).stroke('#0a192f'); doc.rect(28, 28, pw - 56, ph - 56).lineWidth(1).stroke('#cda434');

      let currentY = 195;
      doc.font('Helvetica-Bold').fontSize(24).fillColor('#0a192f').text('RENAISSANCE GLOBAL', 0, currentY, { align: 'center', width: pw, characterSpacing: 2 }); currentY += 30;
      doc.font('Helvetica').fontSize(12).fillColor('#475569').text('COLLEGE OF OPEN & VIRTUAL LEARNING', 0, currentY, { align: 'center', width: pw, characterSpacing: 1 }); currentY += 65;

      const pillWidth = 320; doc.roundedRect((pw - pillWidth) / 2, currentY, pillWidth, 34, 17).fill('#10b981');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text(`VERIFIED: YEAR ${academic_year} - SEMESTER ${academic_semester}`, 0, currentY + 11.5, { align: 'center', width: pw, characterSpacing: 1 }); currentY += 65;

      const cardX = 65; const cardWidth = pw - (cardX * 2); const cardY = currentY;
      doc.roundedRect(cardX, cardY, cardWidth, 190, 8).fillAndStroke('#f8fafc', '#cbd5e1');
      
      currentY += 25; doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e293b').text('STUDENT CREDENTIALS', cardX + 25, currentY);
      doc.moveTo(cardX + 25, currentY + 20).lineTo(cardX + cardWidth - 25, currentY + 20).lineWidth(1).stroke('#e2e8f0'); currentY += 40;

      const leftCol = cardX + 25; const rightCol = cardX + 130; const rowGap = 28;
      const cleanDept = cleanForPDF(department, 'Unassigned');
      const cleanUname = cleanForPDF(username, String(userId));

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#475569').text('Telegram UID:', leftCol, currentY); doc.font('Helvetica-Bold').fillColor('#0f172a').text(String(userId), rightCol, currentY); currentY += rowGap;
      doc.font('Helvetica-Bold').fillColor('#475569').text('Username:', leftCol, currentY); doc.font('Helvetica').fillColor('#0f172a').text(`@${cleanUname}`, rightCol, currentY); currentY += rowGap;
      doc.font('Helvetica-Bold').fillColor('#475569').text('Department:', leftCol, currentY); doc.font('Helvetica-Bold').fillColor('#0a192f').text(cleanDept, rightCol, currentY, { width: cardWidth - 140 }); currentY += rowGap;
      doc.font('Helvetica-Bold').fillColor('#475569').text('Academic Term:', leftCol, currentY); doc.font('Helvetica-Bold').fillColor('#0f172a').text(`Year ${academic_year} - Semester ${academic_semester}`, rightCol, currentY);
      
      currentY = cardY + 190 + 35; 

      const authX = 80; doc.font('Helvetica-Bold').fontSize(11).fillColor('#334155').text('VERIFICATION DETAILS', authX, currentY);
      doc.font('Helvetica').fontSize(10).fillColor('#475569');
      doc.text(`Authorized By: ${cleanForPDF(staffName, 'System Admin')}`, authX, currentY + 20); 
      doc.text(`Timestamp: ${new Date().toLocaleString()}`, authX, currentY + 38);

      const qrData = botUsername ? `https://t.me/${botUsername}?start=verify_${userId}` : `RENAISSANCE_GLOBAL_VERIFY:${userId}`;
      const qrBuffer = await QRCode.toBuffer(qrData, { width: 110, margin: 1, color: { dark: '#0a192f', light: '#ffffff' } });
      const qrX = pw - 80 - 110; doc.rect(qrX - 2, currentY - 2, 114, 114).lineWidth(1).stroke('#cbd5e1'); doc.image(qrBuffer, qrX, currentY);

      doc.end();
    } catch (err) { 
      reject(err); 
    }
  });
}

module.exports = { generateApprovalPDF };