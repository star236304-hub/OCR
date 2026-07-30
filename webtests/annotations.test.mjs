import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfLib from 'pdf-lib';

import { inspectAnnotations, stripAnnotations, HANDWRITING_SUBTYPES } from '../web/js/annotations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// annotated.pdf mimics a PDF marked up in an iPad app: two Ink strokes, a
// highlight and a text box on page 1, a Link annotation that belongs to the
// document itself, and a second page with nothing on it.
function loadFixture() {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'annotated.pdf'));
  return new Uint8Array(buf).buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function subtypesIn(bytes) {
  const doc = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const found = [];
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = page.node.context.lookup(annots.get(i));
      const sub = dict?.get?.(pdfLib.PDFName.of('Subtype'));
      if (sub) found.push(String(sub).replace(/^\//, ''));
    }
  }
  return found;
}

test('inspectAnnotations reports handwriting markup without modifying the file', async () => {
  const bytes = loadFixture();
  const before = new Uint8Array(bytes.slice(0));

  const found = await inspectAnnotations(bytes, { pdfLib });
  assert.equal(found.total, 4);
  assert.equal(found.pages, 1);
  assert.deepEqual(found.bySubtype, { Ink: 2, Highlight: 1, FreeText: 1 });

  assert.deepEqual(new Uint8Array(bytes.slice(0)), before, 'input must not be mutated');
});

test('stripAnnotations removes every handwriting annotation', async () => {
  const { bytes, removed, pages } = await stripAnnotations(loadFixture(), { pdfLib });
  assert.equal(removed, 4);
  assert.equal(pages, 1);

  const left = await subtypesIn(bytes);
  for (const subtype of left) {
    assert.ok(!HANDWRITING_SUBTYPES.has(subtype), `${subtype} should have been removed`);
  }
});

test('links and form fields survive - they are the document, not markup', async () => {
  const { bytes } = await stripAnnotations(loadFixture(), { pdfLib });
  assert.ok((await subtypesIn(bytes)).includes('Link'), 'the Link annotation must be kept');
});

test('page content is untouched, so text stays real text', async () => {
  const original = await pdfLib.PDFDocument.load(loadFixture(), { ignoreEncryption: true });
  const { bytes } = await stripAnnotations(loadFixture(), { pdfLib });
  const stripped = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true });

  assert.equal(stripped.getPageCount(), original.getPageCount());
  for (let i = 0; i < original.getPageCount(); i++) {
    assert.deepEqual(
      stripped.getPage(i).getSize(),
      original.getPage(i).getSize(),
      `page ${i + 1} was resized`
    );
  }
});

test('a PDF with no markup reports nothing and is left alone', async () => {
  const doc = await pdfLib.PDFDocument.create();
  doc.addPage([200, 200]);
  const plain = (await doc.save()).buffer;

  const found = await inspectAnnotations(plain.slice(0), { pdfLib });
  assert.equal(found.total, 0);

  const { removed, pages } = await stripAnnotations(plain.slice(0), { pdfLib });
  assert.equal(removed, 0);
  assert.equal(pages, 0);
});
