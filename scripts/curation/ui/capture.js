/* global window, document, fetch */
"use strict";
window.artvennCapture = (card, object, objects, csrf, notice) => {
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const post = async (value) => {
    const response = await fetch("/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.category || "保存未完成");
    return result;
  };
  if (object.assets.length) {
    const panel = el("details");
    panel.append(el("summary", "拍摄事件资料（可选）"));
    let loaded = false;
    panel.ontoggle = async () => {
      if (!panel.open || loaded) return;
      loaded = true;
      try {
        const response = await fetch(
          "/capture-data?objectId=" + encodeURIComponent(object.id),
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.category);
        const form = el("form");
        form.append(
          el(
            "p",
            "勾选本次拍摄事件对应的来源照片。日期或时区不确定时留空；已有来源关联保留，只能勾选新增关联；保存资料不会改变照片归属。",
          ),
        );
        const choose = el("select");
        const fresh = el("option", "新建拍摄事件");
        fresh.value = "";
        choose.append(fresh);
        for (const capture of data.captures) {
          const option = el(
            "option",
            capture.metadata.label || "未命名拍摄事件",
          );
          option.value = capture.id;
          choose.append(option);
        }
        form.append(choose);
        const fields = {};
        for (const [key, title] of Object.entries({
          label: "事件名称",
          captured_at: "拍摄日期或时间（ISO 日期）",
          timezone: "时区（例如 Asia/Shanghai；未知留空）",
          location: "地点文字",
          photographer: "摄影者",
          device: "设备",
          notes: "备注",
        })) {
          const label = el("label", title);
          const input = el(key === "notes" ? "textarea" : "input");
          input.maxLength = key === "notes" ? 4000 : 240;
          fields[key] = input;
          label.append(input);
          form.append(label);
        }
        const checks = [];
        for (const origin of data.occurrences) {
          const label = el("label");
          const check = el("input");
          check.type = "checkbox";
          checks.push([check, origin.id]);
          label.append(
            check,
            origin.filename + " · " + origin.batchId.slice(-8),
          );
          form.append(label);
        }
        choose.onchange = () => {
          const capture = data.captures.find((c) => c.id === choose.value);
          for (const [key, input] of Object.entries(fields))
            input.value = capture?.metadata[key] || "";
          const ids = new Set(
            capture?.associations.map((a) => a.occurrence_id) || [],
          );
          for (const [check, id] of checks) {
            check.checked = ids.has(id);
            check.disabled = ids.has(id);
          }
        };
        const save = el("button", "确认并保存拍摄事件资料");
        save.type = "submit";
        form.append(save);
        form.onsubmit = async (event) => {
          event.preventDefault();
          for (const control of form.elements) control.disabled = true;
          try {
            const selected = data.captures.find((c) => c.id === choose.value);
            const result = await post({
              action: "save-capture",
              objectId: object.id,
              captureId: choose.value || null,
              revision: selected?.revision,
              metadata: Object.fromEntries(
                Object.entries(fields).map(([key, input]) => [
                  key,
                  input.value.trim() || null,
                ]),
              ),
              occurrenceIds: checks
                .filter(([check]) => check.checked)
                .map(([, id]) => id),
              confirmed: true,
            });
            const index = data.captures.findIndex((c) => c.id === result.id);
            if (index >= 0) data.captures[index] = result;
            else {
              data.captures.push(result);
              const option = el(
                "option",
                result.metadata.label || "未命名拍摄事件",
              );
              option.value = result.id;
              choose.append(option);
            }
            choose.value = result.id;
            choose.selectedOptions[0].textContent =
              result.metadata.label || "未命名拍摄事件";
            choose.onchange();
            notice.textContent =
              "拍摄资料已保存，修订 " + result.revision + "。";
          } catch (error) {
            notice.textContent = error.message;
          } finally {
            for (const control of form.elements) control.disabled = false;
            const capture = data.captures.find((c) => c.id === choose.value);
            const ids = new Set(
              capture?.associations.map((a) => a.occurrence_id) || [],
            );
            for (const [check, id] of checks) check.disabled = ids.has(id);
          }
        };
        panel.append(form);
      } catch (error) {
        loaded = false;
        notice.textContent = error.message;
      }
    };
    card.append(panel);
  }
  if (!object.assets.length && object.movedTo.length) {
    const panel = el("details");
    panel.append(el("summary", "确认整个原组对应同一物理对象"));
    panel.append(
      el(
        "p",
        "仅在原组全部照片已明确审核到同一目标后确认。原编号、决定和冲突资料保留。",
      ),
    );
    const select = el("select");
    for (const target of objects.filter(
      (o) => o.id !== object.id && object.movedTo.includes(o.code),
    )) {
      const option = el("option", target.code + " · " + target.name);
      option.value = target.id;
      select.append(option);
    }
    const acknowledged = el("input");
    acknowledged.type = "checkbox";
    const label = el("label", "我确认整个原组对应所选物理对象");
    label.prepend(acknowledged);
    const save = el("button", "保存明确对象别名");
    save.type = "button";
    save.onclick = async () => {
      if (!acknowledged.checked) {
        notice.textContent = "请先明确确认整个对象身份。";
        return;
      }
      save.disabled = true;
      try {
        await post({
          action: "resolve-object-alias",
          objectId: object.id,
          targetId: select.value,
          confirmed: true,
          revision: object.identity?.revision || 0,
        });
        notice.textContent = "对象别名已保存；历史编号和决定保留。";
      } catch (error) {
        notice.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    };
    panel.append(select, label, save);
    card.append(panel);
  }
};
