/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { Buffer } from 'node:buffer';

// Minimal dependency-free DOCX writer. A .docx is a zip of XML parts; these
// helpers produce a valid single-document Word file with headings and body text.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, end]);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraph(text, { bold = false, code = false, size = 22 } = {}) {
  const props = [
    bold ? '<w:b/>' : '',
    code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : '',
    `<w:sz w:val="${size}"/>`,
  ]
    .filter(Boolean)
    .join('');
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r>${
    props ? `<w:rPr>${props}</w:rPr>` : ''
  }<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function heading(text) {
  return paragraph(text, { bold: true, size: 26 });
}

function lines(value, options) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item) => String(item ?? '').trim())
    .map((item) => paragraph(item, options))
    .join('');
}

export function buildReportDocx(report) {
  const body = [
    paragraph(report.title, { bold: true, size: 34 }),
    paragraph(
      `${String(report.severity).toUpperCase()} · ${report.status} · review: ${report.review} · v${report.version}`
    ),
    heading('Summary'),
    paragraph(report.summary),
    heading('Affected asset'),
    paragraph(report.affectedAsset),
    heading('Classification'),
    lines(report.cwe.map((item) => `• ${item}`)),
    paragraph(report.cvss, { code: true }),
    heading('Steps to reproduce'),
    lines(report.steps.map((step, index) => `${index + 1}. ${step}`)),
    heading('Request'),
    lines(report.request, { code: true }),
    heading('Response'),
    lines(report.response, { code: true }),
  ];

  if (report.proof) {
    body.push(heading('Proof'));
    body.push(paragraph(report.proof));
  }
  if (report.pocScript) {
    body.push(heading('PoC script'));
    body.push(paragraph(report.pocScript));
  }

  body.push(heading('What this gives an attacker'), paragraph(report.attackerValue));

  if (report.testedRuledOut?.length) {
    body.push(heading('What was tested and ruled out'));
    body.push(lines(report.testedRuledOut.map((item) => `• ${item}`)));
  }

  body.push(heading('Impact'), paragraph(report.impact));
  body.push(heading('Remediation'));
  body.push(lines(report.remediation.map((item, index) => `${index + 1}. ${item}`)));
  body.push(
    paragraph(
      `Channel: ${report.channelId} · Reporter: ${report.createdBy} · ${report.time} · Report ${report.id}`
    )
  );
  if (report.reviewedBy) {
    body.push(
      paragraph(
        `Reviewed by ${report.reviewedBy} at ${report.reviewedTime ?? ''}${
          report.reviewNote ? ` - ${report.reviewNote}` : ''
        }`
      )
    );
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join(
    ''
  )}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
  ]);
}

export function safeFilename(value) {
  return String(value ?? 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}
