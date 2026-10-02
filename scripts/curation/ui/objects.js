/* global document, location, URLSearchParams, fetch, window */
(() => {
  "use strict";
  const root = document.getElementById("av-objects");
  const notice = document.getElementById("av-notice");
  const csrf = document.cookie
    .split("; ")
    .find((x) => x.startsWith("curation_csrf="))
    ?.split("=")[1];
  const options = new URLSearchParams(location.search);
  const material = options.get("material") || "all";
  if (material === "synthetic")
    document.querySelector("header > a").href = "/?material=synthetic";
  const focus = options.get("focus");
  const scope = options.get("scope") || "library";
  if (options.get("review")) {
    root.hidden = true;
    document.getElementById("av-review-selection").hidden = true;
    document.getElementById("av-dataset-export").hidden = true;
    return;
  }
  let available = [];
  let starting = false;
  const selected = new Set();
  function selectionChanged() {
    const chosen = available.filter((o) => selected.has(o.id));
    const count = new Set(chosen.flatMap((o) => o.assets.map((a) => a.id)))
      .size;
    document.getElementById("av-selection-count").textContent =
      "已选 " + chosen.length + " 组，共 " + count + " 张照片";
    document.getElementById("av-begin-review").disabled = !count;
  }
  document.getElementById("av-begin-review").onclick = async () => {
    if (starting) return;
    starting = true;
    document.getElementById("av-begin-review").disabled = true;
    try {
      const chosen = available.filter((o) => selected.has(o.id));
      const kinds = new Set(chosen.map((o) => o.synthetic));
      if (kinds.size !== 1)
        throw new Error("请分别整理真实资料与合成测试资料。");
      const chosenMaterial = chosen[0].synthetic ? "synthetic" : "local";
      const response = await fetch("/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          action: "begin-review",
          material: chosenMaterial,
          objectIds: chosen.map((o) => o.id),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.category || "无法开始本次整理");
      location.href =
        "/objects?material=" + chosenMaterial + "&review=" + result.id;
    } catch (error) {
      notice.textContent = error.message;
      starting = false;
      selectionChanged();
    }
  };
  document.getElementById("av-export-dataset").onclick = async () => {
    const ids = available.filter((o) => selected.has(o.id)).map((o) => o.id);
    if (!ids.length) {
      notice.textContent = "请先选择要导出的对象。";
      return;
    }
    const control = document.getElementById("av-export-dataset");
    control.disabled = true;
    try {
      const response = await fetch("/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          action: "export-dataset",
          objectIds: ids,
          confirmed: true,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.category || "导出未完成");
      notice.textContent = "Dataset 已保存到本机：" + result.path;
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      control.disabled = false;
    }
  };
  const labels = {
    accepted: "已收集",
    corrected: "已收集人工修正",
    rejected: "已收集拒绝",
    deferred: "暂缓处理",
  };
  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function photo(asset) {
    const figure = el("figure");
    figure.className = "av-photo";
    const image = el("img");
    image.src = asset.url;
    image.alt = asset.filename;
    image.loading = "lazy";
    figure.append(image, el("figcaption", asset.filename));
    return figure;
  }
  function render(objects) {
    available = objects;
    root.replaceChildren();
    for (const object of objects) {
      const card = el("section");
      card.className = "av-object";
      card.id = object.id;
      if (focus === object.id) card.classList.add("av-focused");
      const code = el("div", object.code);
      code.className = "av-code";
      card.append(code, el("h2", object.name));
      if (object.assets.length) {
        const choose = el("input");
        choose.type = "checkbox";
        choose.checked = selected.has(object.id);
        choose.onchange = () => {
          if (choose.checked) selected.add(object.id);
          else selected.delete(object.id);
          selectionChanged();
        };
        const chooseLabel = el("label");
        chooseLabel.className = "av-check";
        chooseLabel.append(
          choose,
          " 选择这组 " + object.assets.length + " 张照片",
        );
        card.append(chooseLabel);
      }
      if (object.membership === "已收集的人工分组" && object.assets.length) {
        const add = el("button", "为这个对象增补照片");
        add.type = "button";
        add.onclick = async () => {
          add.disabled = true;
          try {
            const response = await fetch("/action", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrf,
              },
              body: JSON.stringify({
                action: "begin-intake",
                objectId: object.id,
              }),
            });
            const value = await response.json();
            if (!response.ok) throw new Error(value.category || "无法增补照片");
            if (value.id)
              location.href =
                "/objects?material=" + value.material + "&review=" + value.id;
            else
              notice.textContent =
                value.status === "already_present"
                  ? "这些照片已经属于这个对象，来源位置已保留。"
                  : "已取消选择。";
          } catch (error) {
            notice.textContent = error.message;
          } finally {
            add.disabled = false;
          }
        };
        card.append(add);
      }
      const meta = el(
        "p",
        object.materialLabel +
          " · " +
          object.nameSource +
          " · " +
          object.membership +
          " · " +
          object.assets.length +
          " 张照片",
      );
      meta.className = "av-meta";
      card.append(meta);
      if (object.synthetic) {
        const badge = el("span", "SYNTHETIC FIXTURE / 合成测试");
        badge.className = "av-badge";
        card.append(badge);
      }
      const form = el("form");
      const label = el("label", "本地名称（例如：南壁长篇题刻、东侧小字碑）");
      const input = el("input");
      input.maxLength = 120;
      input.value = object.workingName;
      input.placeholder = "给这组照片起一个你能认出的名称";
      input.id = "name-" + object.id;
      label.htmlFor = input.id;
      const save = el("button", "保存名称");
      save.type = "submit";
      form.append(label, input, save);
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
          const response = await fetch("/action", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
            },
            body: JSON.stringify({
              action: "rename-object",
              objectId: object.id,
              name: input.value,
            }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.category || "名称保存失败");
          notice.textContent =
            object.code + " 的本地名称已保存；公开标题不变。";
          await load(false);
        } catch (error) {
          notice.textContent = error.message;
        } finally {
          save.disabled = false;
        }
      };
      card.append(form);
      const gallery = el("div");
      gallery.className = "av-gallery";
      for (const asset of object.assets) gallery.append(photo(asset));
      card.append(gallery);
      if (!object.assets.length)
        card.append(
          el(
            "p",
            object.movedTo?.length
              ? "照片已归入 " +
                  object.movedTo.join("、") +
                  "；原分组与审核历史保留。"
              : "当前组没有保留的照片。原始文件仍在本机。",
          ),
        );
      const actions = el("div");
      actions.className = "av-actions";
      for (const task of object.tasks) {
        const group = el("div");
        const link = el("a", task.label);
        link.href = task.url + (object.synthetic ? "&synthetic=1" : "");
        const status = el(
          "span",
          task.collected
            ? labels[task.collected] || task.collected
            : "待审核 / 待收集",
        );
        status.className = "av-task-status";
        group.append(link, status);
        actions.append(group);
      }
      if (!object.tasks.length)
        actions.append(el("p", "此对象暂无当前审核任务。"));
      card.append(actions);
      window.artvennCapture?.(card, object, objects, csrf, notice);
      root.append(card);
    }
    if (!objects.length)
      root.append(
        el("p", "这一分类还没有对象。先从本地整理入口选择文件夹并分析。"),
      );
    selectionChanged();
  }
  async function load(scroll = true) {
    try {
      const response = await fetch(
        "/object-data?material=" +
          encodeURIComponent(material) +
          "&scope=" +
          encodeURIComponent(scope),
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.category || "读取对象目录失败");
      render(value.objects);
      if (scroll && focus) document.getElementById(focus)?.scrollIntoView();
    } catch (error) {
      notice.textContent = error.message;
    }
  }
  load();
})();
