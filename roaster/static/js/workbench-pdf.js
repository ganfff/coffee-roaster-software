/* A small offline multi-page PDF writer. Canvas JPEG pages preserve CJK text. */
(function () {
  'use strict';
  window.WorkbenchPDF = {
    build(canvases) {
      const chunks = [], offsets = [0];
      let length = 0;
      const encoder = new TextEncoder();
      const append = value => { const bytes = typeof value === 'string' ? encoder.encode(value) : value; chunks.push(bytes); length += bytes.length; };
      const object = (id, content) => { offsets[id] = length; append(`${id} 0 obj\n`); append(content); append('\nendobj\n'); };
      append('%PDF-1.4\n');
      object(1, '<< /Type /Catalog /Pages 2 0 R >>');
      object(2, `<< /Type /Pages /Count ${canvases.length} /Kids [${canvases.map((_, i) => `${3+i*3} 0 R`).join(' ')}] >>`);
      canvases.forEach((canvas, index) => {
        const id = 3 + index * 3;
        const data = atob(canvas.toDataURL('image/jpeg', .92).split(',')[1]);
        const jpeg = Uint8Array.from(data, c => c.charCodeAt(0));
        object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /XObject << /Image${index} ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
        offsets[id+1] = length;
        append(`${id+1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
        append(jpeg); append('\nendstream\nendobj\n');
        const commands = `q 842 0 0 595 0 0 cm /Image${index} Do Q`;
        object(id+2, `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}\nendstream`);
      });
      const xref = length;
      append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
      for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
      append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      return new Blob(chunks, {type:'application/pdf'});
    }
  };
})();
