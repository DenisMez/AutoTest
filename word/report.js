"use strict";

const wordReport = (() => {
  const {
    AlignmentType, BorderStyle, Document, ExternalHyperlink, ImageRun, Packer, PageOrientation,
    Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType
  } = docx;
  const columns = [4254, 8874, 2007];
  const border = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
  const font = "Times New Roman";
  const clean = (value) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");

  function paragraph(value, { bold = false, alignment = AlignmentType.LEFT, label = "", after = 0 } = {}) {
    const lines = clean(value).split(/\r\n?|\n/);
    const children = lines.map((line, index) => new TextRun({ text: line, bold, break: index ? 1 : undefined }));
    if (label) children.unshift(new TextRun({ text: label + " ", bold: true }));
    return new Paragraph({ children, alignment, spacing: { after } });
  }

  function hyperlink(value, label) {
    const link = inputData.httpUrl(value);
    if (!link) return paragraph(value, { label });
    return new Paragraph({
      children: [new ExternalHyperlink({
        link: link.href,
        children: [new TextRun({ text: clean(label), color: "0563C1", underline: {} })]
      })],
      spacing: { after: 30 }
    });
  }

  function screenshot(asset) {
    const scale = Math.min(1, 550 / asset.width, 410 / asset.height);
    const image = new ImageRun({
      type: "png",
      data: asset.data,
      transformation: { width: Math.max(1, Math.round(asset.width * scale)), height: Math.max(1, Math.round(asset.height * scale)) },
      altText: { title: asset.name, description: asset.name, name: asset.name }
    });
    return new Paragraph({ children: [image], spacing: { before: 35, after: 45 } });
  }

  function cell(children, index, { span = 1, fill } = {}) {
    return new TableCell({
      children: children.length ? children : [paragraph("")],
      width: { size: columns.slice(index, index + span).reduce((a, b) => a + b, 0), type: WidthType.DXA },
      columnSpan: span,
      shading: fill ? { fill, color: "auto" } : undefined
    });
  }

  function information(label, value, { fill, bold = false } = {}) {
    return new TableRow({ cantSplit: true, children: [
      cell([paragraph(label, { bold })], 0, { fill }),
      cell(Array.isArray(value) ? value : [paragraph(value, { bold })], 1, { span: 2, fill })
    ] });
  }

  function caseRow(item) {
    const evidence = [];
    if (item.expected.trim()) evidence.push(paragraph(item.expected, { after: 35 }));
    if (item.comment.trim()) evidence.push(paragraph(item.comment, { label: "Комментарий", after: 35 }));
    item.images.forEach((asset) => evidence.push(screenshot(asset)));
    if (item.missingScreenshots) evidence.push(paragraph("Недоступных скриншотов: " + item.missingScreenshots));
    return new TableRow({ children: [
      cell([paragraph(item.action)], 0),
      cell(evidence, 1),
      cell([paragraph(inputData.status(item.status))], 2)
    ] });
  }

  function preconditionRow(action, expected = "") {
    return new TableRow({ cantSplit: true, children: [
      cell([action], 0),
      cell([paragraph(expected)], 1),
      cell([paragraph("пройден")], 2)
    ] });
  }

  function table(run, info) {
    const rows = [
      information("Название:", info.title, { bold: true }),
      information("Функция:", info.version || run.version),
      information("Исполнитель:", run.tester),
      information("Заявитель — Наименование МО:", info.organization, { fill: "F4CCCC" })
    ];
    rows.push(new TableRow({ cantSplit: true, children: [
      cell([paragraph("Действие", { bold: true })], 0),
      cell([paragraph("Ожидаемый результат", { bold: true })], 1),
      cell([paragraph("Результат теста:", { bold: true }), paragraph("пройден\nпровален\nзаблокирован")], 2)
    ] }));
    rows.push(
      information("Предусловие:", "", { fill: "E6E6E6", bold: true }),
      preconditionRow(hyperlink(info.taskLink, "Ссылка на задачу")),
      preconditionRow(
        paragraph("Запустить kis ТЕСТ М99 и ввести логин/пароль для входа в систему (Пользователь ВРАЧТП-333, Администратора, С8 ПО)"),
        "Окно для ввода логин/пароль открыто и доступно, ввести данные"
      ),
      preconditionRow(paragraph("Обратившиеся"), "Список открыт и доступен")
    );
    rows.push(information("Шаги:", "", { fill: "E6E6E6", bold: true }));
    rows.push(...run.cases.map(caseRow));
    if (info.postcondition) rows.push(information("Постусловие:", info.postcondition, { fill: "E6E6E6", bold: true }));
    return new Table({
      rows,
      width: { size: columns.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      columnWidths: columns,
      layout: TableLayoutType.FIXED,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      margins: { top: 45, bottom: 45, left: 113, right: 108 }
    });
  }

  function build(runs, info) {
    if (!inputData.taskUrl(info.taskLink)) throw new Error("Укажите полный адрес задачи.");
    const properties = {
      page: {
        size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
        margin: { top: 566, right: 566, bottom: 850, left: 1133 }
      }
    };
    const file = new Document({
      title: clean(info.title),
      styles: { default: { document: {
        run: { font, size: 22, color: "000000", language: { value: "ru-RU" } },
        paragraph: { spacing: { before: 0, after: 0 } }
      } } },
      sections: runs.map((run) => ({ properties, children: [table(run, info)] }))
    });
    return Packer.toBlob(file);
  }

  return { build };
})();
