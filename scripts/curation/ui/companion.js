/* global document, window, location, URLSearchParams, fetch, AbortController, setInterval, clearInterval */
(() => {
  "use strict";
  const projectMatch = location.pathname.match(/^\/projects\/(\d+)\/data\/$/);
  if (!projectMatch) return;
  const root = document.createElement("aside");
  root.id = "artvenn-object-companion";
  root.hidden = true;
  root.setAttribute("aria-label", "ArtVenn 对象身份与分组参照");
  document.body.append(root);
  let current = null,
    generation = 0,
    controller = null,
    manager = null;
  const listeners = ["annotationSet", "lsfInit", "modeChanged", "closeTask"];
  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function activeTask() {
    const match = location.pathname.match(/^\/projects\/(\d+)\/data\/$/);
    const dm = window.dataManager,
      wrapper = dm?.lsf;
    if (!match || dm?.store?.loadingData || wrapper?.lsf?.isLoading)
      return null;
    const active = Number(wrapper?.task?.id),
      editor = Number(wrapper?.lsf?.task?.id);
    const requested = new URLSearchParams(location.search).get("task");
    if (
      !Number.isSafeInteger(active) ||
      active < 1 ||
      editor !== active ||
      (requested && Number(requested) !== active)
    )
      return null;
    return {
      task: active,
      project: Number(match[1]),
      key: match[1] + ":" + active,
    };
  }
  function objectCard(object, heading) {
    const block = el("section");
    block.append(el("h3", heading));
    const code = el("div", object.code);
    code.className = "av-code";
    block.append(code, el("h2", object.name));
    const meta = el(
      "p",
      object.materialLabel +
        " · " +
        object.nameSource +
        " · " +
        object.membership,
    );
    meta.className = "av-meta";
    block.append(meta);
    if (object.synthetic) {
      const badge = el("span", "SYNTHETIC FIXTURE");
      badge.className = "av-badge";
      block.append(badge);
    }
    const gallery = el("div");
    gallery.className = "av-gallery";
    for (const asset of object.assets) {
      const figure = el("figure");
      figure.className = "av-photo";
      const image = el("img");
      image.src = asset.url;
      image.alt = asset.filename;
      image.loading = "lazy";
      figure.append(image, el("figcaption", asset.filename));
      gallery.append(figure);
    }
    block.append(gallery);
    return block;
  }
  function render(context) {
    const panel = el("details");
    panel.open = window.innerWidth > 900;
    panel.append(
      el(
        "summary",
        context.current.name +
          " · " +
          context.current.code +
          "（对象身份，可收起）",
      ),
    );
    const body = el("div");
    body.className = "av-companion-body";
    body.append(
      objectCard(
        context.current,
        context.kind === "relationship" ? "参与比较的对象 A" : "当前审核对象",
      ),
    );
    const edit = el("a", "打开对象目录 / 修改本地名称");
    edit.href = context.directory;
    edit.target = "_blank";
    edit.rel = "noopener";
    body.append(edit);
    const instruction = el("p");
    instruction.className = "av-instruction";
    if (context.kind === "group") {
      instruction.textContent =
        "belongs = 保留在上面这组。remove = 从这组移出。reassign = 改分到下面某组。split = 新建另一组。不确定选 unresolved。";
      body.append(instruction);
      const targets = el("details");
      targets.append(el("summary", "查看改分目标（名称 + 照片）"));
      for (const target of context.targets) {
        const item = el("details");
        item.className = "av-target";
        item.append(
          el(
            "summary",
            "下方选择「" +
              target.choice +
              "」→ " +
              target.object.code +
              " · " +
              target.object.name,
          ),
        );
        item.append(objectCard(target.object, "改分目标"));
        targets.append(item);
      }
      body.append(targets);
    } else if (context.kind === "relationship") {
      body.append(objectCard(context.other, "参与比较的对象 B"));
      instruction.textContent =
        "按两张对象卡片的整组照片判断关系。原审核图片区块和顺序保持不变。";
      body.append(instruction);
    } else {
      instruction.textContent =
        "正在审核「" +
        context.field +
        "」。整组照片用于辨认对象；原任务图片区为该字段的证据。";
      body.append(instruction);
    }
    panel.append(body);
    root.replaceChildren(panel);
    root.hidden = false;
  }
  async function update() {
    const active = activeTask();
    if ((active?.key || null) === current) return;
    current = active?.key || null;
    const token = ++generation;
    controller?.abort();
    root.hidden = true;
    root.replaceChildren();
    if (!active) return;
    controller = new AbortController();
    try {
      const response = await fetch(
        "/curation/context?project=" + active.project + "&task=" + active.task,
        { signal: controller.signal, cache: "no-store" },
      );
      if (!response.ok) return;
      const context = await response.json();
      if (
        token !== generation ||
        activeTask()?.key !== active.key ||
        context.task !== active.task ||
        context.project !== active.project
      )
        return;
      render(context);
    } catch {
      /* Task switching may abort a read; no native state is changed. */
    }
  }
  function connect() {
    if (window.dataManager && manager !== window.dataManager) {
      if (manager?.off)
        for (const event of listeners) manager.off(event, update);
      manager = window.dataManager;
      if (manager.on) for (const event of listeners) manager.on(event, update);
    }
    update();
  }
  const timer = setInterval(() => {
    if (!document.hidden) connect();
  }, 1000);
  window.addEventListener("popstate", connect);
  window.addEventListener("focus", () => {
    current = null;
    connect();
  });
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(timer);
      controller?.abort();
      if (manager?.off)
        for (const event of listeners) manager.off(event, update);
    },
    { once: true },
  );
  connect();
})();
