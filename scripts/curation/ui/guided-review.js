/* global document, location, URLSearchParams, fetch */
(() => {
  "use strict";
  const query = new URLSearchParams(location.search);
  const reviewId = query.get("review");
  if (!reviewId) return;
  const material = query.get("material");
  const root = document.getElementById("av-workbench");
  const notice = document.getElementById("av-notice");
  const csrf = document.cookie
    .split("; ")
    .find((x) => x.startsWith("curation_csrf="))
    ?.split("=")[1];
  const roleNames = {
    overview: "整体图",
    detail: "局部细节",
    label: "展签",
    context: "环境",
    unspecified: "用途待确定",
  };
  const states = {
    draft: "填写已保存 · 尚未确认决定",
    submitting: "保存未完成 · 正在核对原生审核提交",
    submitted_waiting_collection: "审核已提交 · 正式收集尚未完成",
    collected: "正式决定已保存到本机",
    package_prepared: "正式决定与卡片内容已保存",
  };
  const errors = {
    EXISTING_FIELD_DISPOSITION_REQUIRED:
      "已有建议需要明确处理：采用、不采用或暂缓。请勿选择“没有此项资料”。",
    NO_FIELD_PROPOSAL_TO_REVIEW:
      "这项原来没有建议：请填写新资料，或选择“没有此项资料，不新增”。",
    CONFIRMED_NATIVE_ANNOTATION_CHANGED:
      "原审核记录在保存过程中被修改。已完成记录保留，请回对象目录核对当前版本。",
    WORKING_NAME_INVALID: "请使用不超过 120 个字的单行本地名称。",
    REVIEW_PREVIEW_STALE:
      "资料或审核版本发生了变化。请回对象资料库重新选择这几组，再核对。",
    REVIEW_FIELD_VALUE_REQUIRED:
      "需要采用的资料尚未填写完整。填写已保留，请补齐后确认。",
    NECESSARY_FIELDS_REQUIRED:
      "请先确认卡片标题；历史资料不确定时可以明确暂缓。",
    NATIVE_DECISIONS_NEED_COLLECTION:
      "这些组还有原审核页已提交但未收集的判断，请先回工作台收集。",
    NATIVE_SUBMISSION_OUTCOME_UNKNOWN:
      "有一次提交尚无法确认结果。填写与已完成决定都保留，请继续核对；系统不会盲目重复提交。",
    PUBLIC_MEDIA_SCOPE_INVALID: "请明确选择至少一张本次已确认的照片。",
    PUBLIC_MEDIA_ORDER_OR_REPRESENTATIVE_INVALID:
      "请为已选照片设置不同顺序，并选一张代表图。",
    KEY_FACT_REVIEW_REQUIRED: "还有 AI 建议未处理；可采用、不采用或明确暂缓。",
    REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED:
      "卡片已保存在本机。需明确授权目标环境与这几张照片后，才能上传到 Admin Draft。",
    REAL_MATERIAL_AUTHORIZATION_INVALID:
      "目标或选中资料与授权不一致，未执行传输。",
    EDITORIAL_TARGET_NOT_CONFIGURED: "目标 Admin 尚未配置，卡片保留在本机。",
    UNSUPPORTED_CATALOG_KIND: "请选择草稿正式类型：碑刻或书法。",
    INTAKE_TARGET_STALE: "目标对象已被更新，请重新选择新增照片并核对目标。",
    INTAKE_EXISTING_FACTS_PRESERVED:
      "增补照片时保留原资料，请在对象整理中另行审核资料。",
    CURRENT_MEDIA_REVIEW_REQUIRED:
      "照片的审核版本已变化，请完成当前审核再准备。",
  };
  let session;
  let draft;
  let busy = false;
  let acknowledged;
  let packageDraft;
  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, action) {
    const node = el("button", text);
    node.type = "button";
    node.onclick = action;
    return node;
  }
  function select(options, value, change) {
    const node = el("select");
    for (const [key, text] of options) {
      const option = el("option", text);
      option.value = key;
      node.append(option);
    }
    node.value = value;
    node.onchange = () => {
      change(node.value);
      dirty();
    };
    return node;
  }
  function label(text, input) {
    const node = el("label", text);
    node.append(input);
    return node;
  }
  function dirty() {
    if (session.state !== "draft") return;
    if (acknowledged) acknowledged.checked = false;
    document.getElementById("av-local-save-state").textContent =
      "有未保存的填写";
  }
  function titleFor(id) {
    const item = session.objects.find((o) => o.id === id);
    return item ? item.code + " · " + item.name : "移出本次归属";
  }
  function photo(asset) {
    const image = el("img");
    image.src = asset.url;
    image.alt = asset.filename;
    const enlarge = button("查看大图", () => {
      const dialog = el("dialog");
      dialog.className = "av-large-photo";
      const full = el("img");
      full.src = asset.url;
      full.alt = asset.filename;
      dialog.append(
        button("关闭", () => {
          dialog.close();
          dialog.remove();
        }),
        full,
        el("p", asset.filename),
      );
      root.append(dialog);
      dialog.showModal();
    });
    return [image, el("p", asset.filename), enlarge];
  }
  async function load() {
    const response = await fetch(
      "/guided-review?material=" +
        encodeURIComponent(material) +
        "&id=" +
        encodeURIComponent(reviewId),
    );
    const value = await response.json();
    if (!response.ok) throw new Error(value.category || "读取本次整理失败");
    session = value;
    render();
  }
  async function action(name, extra = {}) {
    if (busy) return;
    const attemptedDraft = JSON.parse(JSON.stringify(draft));
    busy = true;
    root.querySelectorAll("button, input, select, textarea").forEach((b) => {
      b.disabled = true;
    });
    notice.textContent =
      name === "confirm-review"
        ? "正在提交并收集本次明确确认的决定…"
        : "正在保存…";
    try {
      const response = await fetch("/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          action: name,
          reviewId,
          material,
          revision: session.revision,
          draft,
          ...extra,
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.category || "操作未完成");
      if (name === "admin-draft") {
        await load();
        notice.textContent = value.failed
          ? "部分草稿未完成，已完成的回执保留，可以继续失败部分。"
          : "Admin Draft 已保存、图片已上传并回读。可打开草稿继续编辑；未发布。";
        return;
      }
      session = value;
      packageDraft = null;
      render();
      notice.textContent = value.error
        ? errors[value.error] || value.error
        : states[value.state];
    } catch (error) {
      notice.textContent = errors[error.message] || error.message;
      try {
        await load();
        if (session.state === "draft") {
          session.draft = attemptedDraft;
          render();
          dirty();
        } else if (
          extra.choice &&
          !session.stale &&
          ["collected", "package_prepared"].includes(session.state) &&
          extra.choice.objectId === session.draft.targetId
        ) {
          packageDraft = extra.choice;
          render();
        }
      } catch {
        /* Preserve the current form when offline. */
      }
    } finally {
      busy = false;
      root.querySelectorAll("button, input, select, textarea").forEach((b) => {
        b.disabled = false;
      });
    }
  }
  function render() {
    root.hidden = false;
    root.replaceChildren();
    acknowledged = null;
    draft = JSON.parse(JSON.stringify(session.draft));
    const editable = session.state === "draft";
    const summary = el("section");
    summary.className = "av-object";
    summary.append(
      el("h2", "本次仅整理 " + session.assetIds.length + " 张照片"),
      el(
        "p",
        session.objects
          .map((o) => o.code + "（" + o.photoCount + " 张）")
          .join(" + "),
      ),
    );
    const state = el("strong", states[session.state]);
    state.id = "av-local-save-state";
    summary.append(
      state,
      el(
        "p",
        "本轮审核任务 " +
          session.progress.tasks +
          " · 已提交 " +
          (session.progress.submitted ?? "待核对") +
          " · 正式已收集 " +
          session.progress.collected,
      ),
    );
    if (session.error)
      summary.append(el("p", errors[session.error] || session.error));
    if (session.stale)
      summary.append(
        el(
          "p",
          "这份已保存的审核已被后续整理更新。请回对象资料库核对当前版本；旧记录仍保留。",
        ),
      );
    root.append(summary);
    const form = el("fieldset");
    form.disabled = !editable;
    form.className = "av-object av-review-form";
    form.append(el("legend", "1 · 照片归属与用途"));
    const target = select(
      session.objects
        .filter((o) => !session.intake || o.id === session.intake.targetId)
        .map((o) => [o.id, o.code + " · " + o.name]),
      draft.targetId,
      (value) => {
        draft.targetId = value;
        updateTarget();
      },
    );
    form.append(label("整理到哪个碑刻档案", target));
    const targetLabel = el("p");
    function updateTarget() {
      targetLabel.textContent =
        "目标：" +
        titleFor(draft.targetId) +
        "。固定编号保留；资料字段不会从其他组自动合并。";
    }
    updateTarget();
    form.append(targetLabel);
    const grid = el("div");
    grid.className = "av-review-grid";
    const destinationInputs = [];
    for (const asset of session.photos) {
      const item = draft.photos.find((p) => p.assetId === asset.id);
      const tile = el("div");
      tile.className = "av-review-photo";
      tile.append(
        ...photo(asset),
        el("p", "原组：" + asset.origins.map(titleFor).join("、")),
      );
      const destination = select(
        [
          ...session.objects.map((o) => [o.id, o.code + " · " + o.name]),
          ["none", "移出本次归属（保留原图）"],
        ],
        item.destination,
        (value) => {
          item.destination = value;
        },
      );
      destinationInputs.push([destination, item]);
      tile.append(
        label("这张照片属于", destination),
        label(
          "照片用途",
          select(Object.entries(roleNames), item.role, (value) => {
            item.role = value;
          }),
        ),
        el(
          "small",
          editable
            ? asset.roleSource || "用途待确认"
            : session.state === "collected" ||
                session.state === "package_prepared"
              ? "本次人工决定已保存"
              : "已确认填写，保存处理中",
        ),
      );
      grid.append(tile);
    }
    form.append(
      button("这些照片都属于上面的同一块碑刻", () => {
        for (const [input, item] of destinationInputs) {
          input.value = draft.targetId;
          item.destination = draft.targetId;
        }
        dirty();
      }),
      grid,
    );
    root.append(form);
    const fields = el("fieldset");
    fields.disabled = !editable;
    fields.className = "av-object av-review-form";
    fields.append(
      el("legend", "2 · 核对与补充资料"),
      el(
        "p",
        "填写内容作为人工补充记录。只填写能确认的信息；其他组的资料不会自动采纳。",
      ),
    );
    const name = el("input");
    name.value = draft.workingName;
    name.maxLength = 120;
    name.oninput = () => {
      draft.workingName = name.value;
      dirty();
    };
    fields.append(label("本地名称（便于你认出，可选）", name));
    const fieldLabels = {
      title: "草稿标题（必填）",
      object_form: "对象类型，例如碑刻（必填）",
      persons: "人物与角色（可选）",
      period_original: "年代原文（可选）",
    };
    for (const key of session.intake ? [] : Object.keys(fieldLabels)) {
      const item = draft.fields[key];
      const input = el("input");
      input.value = item.value;
      input.maxLength = 4000;
      input.oninput = () => {
        item.value = input.value;
        dirty();
      };
      fields.append(
        label(fieldLabels[key], input),
        label(
          "如何处理这项资料",
          select(
            [
              ["set", "采用上面填写的内容"],
              ["reject", "不采用原有建议"],
              ["defer", "暂缓，稍后核对"],
              ["skip", "没有此项资料，不新增"],
            ],
            item.action,
            (value) => {
              item.action = value;
            },
          ),
        ),
      );
    }
    const references = el("details");
    references.append(el("summary", "查看原有建议及其所属组"));
    for (const candidate of session.candidates)
      references.append(
        el(
          "p",
          titleFor(candidate.objectId) +
            " · " +
            (fieldLabels[candidate.field] || candidate.field) +
            "：" +
            candidate.value,
        ),
      );
    fields.append(references);
    if (!session.intake) root.append(fields);
    else root.append(el("p", "本次只审核新增照片；原有成员和资料决定保留。"));
    const controls = el("section");
    controls.className = "av-object";
    if (editable) {
      acknowledged = el("input");
      acknowledged.type = "checkbox";
      const checked = label("", acknowledged);
      checked.className = "av-check";
      checked.append(
        " 我已核对这 " +
          session.assetIds.length +
          " 张照片的归属、用途和上面的资料。",
      );
      controls.append(
        checked,
        button("保存填写，稍后继续", () => action("save-review-draft")),
        button("确认并保存正式决定", () => {
          if (!acknowledged.checked) {
            notice.textContent = "请先核对照片与资料，并勾选确认。";
            return;
          }
          action("confirm-review", { confirmed: true });
        }),
      );
    } else if (
      ["submitting", "submitted_waiting_collection"].includes(session.state)
    ) {
      controls.append(
        button("继续核对提交结果并保存", () =>
          action("confirm-review", { confirmed: true }),
        ),
      );
    }
    const original = el("details");
    original.append(el("summary", "查看本轮原生审核记录"));
    for (const task of session.tasks) {
      const link = el(
        "a",
        { group: "照片归属审核", field: "资料审核" }[task.kind] || "审核记录",
      );
      link.href = task.url;
      original.append(link, el("br"));
    }
    controls.append(original);
    root.append(controls);
    if (["collected", "package_prepared"].includes(session.state))
      renderPackage();
  }
  function renderPackage() {
    if (session.stale) return;
    const section = el("section");
    section.className = "av-object";
    section.append(
      el("h2", "3 · 准备卡片，创建 Admin Draft"),
      el(
        "p",
        "使用已确认的 AI 资料，以及下面选中的照片和代表图。暂缓信息保留未知。",
      ),
    );
    if (session.package)
      section.append(
        el(
          "strong",
          "卡片内容已准备：" +
            session.package.objects +
            " 个对象、" +
            session.package.media +
            " 张照片；未上传。",
        ),
      );
    for (const item of session.adminDrafts || []) {
      const link = el("a", "打开可编辑 Admin Draft");
      link.href = item.url;
      section.append(link, el("br"));
    }
    if (session.package) {
      section.append(
        button("创建可编辑 Admin Draft", () => action("admin-draft")),
        el(
          "p",
          "真实传输只在明确授权的目标与照片范围内执行。仅保存 Draft，不发布或自动批准。",
        ),
      );
    }
    if (session.missing.length) {
      section.append(
        el(
          "p",
          "还有待完成资料：" + session.missing.map((m) => m.label).join("、"),
        ),
      );
      const resume = el("a", "回对象资料库，选择当前碑刻开始新一轮整理");
      resume.href =
        "/objects?material=" +
        material +
        "&focus=" +
        encodeURIComponent(draft.targetId);
      section.append(
        el("p", "本轮决定已保留。继续处理暂缓资料需要新一轮审核。"),
        resume,
      );
      root.append(section);
      return;
    }
    const title = el("input");
    const packageChoice = packageDraft || session.packageChoice;
    title.value = packageChoice?.title || draft.fields.title.value;
    const packageState = el(
      "p",
      packageDraft
        ? "上次未完成的选择保留在页面中，尚未保存。"
        : session.packageChoice
          ? "下面显示已保存的文件包选择。修改后请再次准备。"
          : "请明确勾选本次草稿使用的照片，再选一张代表图。",
    );
    const packageDirty = () => {
      packageState.textContent =
        "文件包选择有改动，尚未重新准备；正式审核决定仍已保存。";
    };
    title.oninput = packageDirty;
    const kind = select(
      [
        ["", "请选择正式类型"],
        ["inscription", "碑刻"],
        ["calligraphy", "书法"],
      ],
      packageChoice?.kind || "",
      packageDirty,
    );
    section.append(
      packageState,
      label("确认草稿标题", title),
      label("正式类型", kind),
    );
    const grid = el("div");
    grid.className = "av-review-grid";
    const chosen = [];
    const assigned = draft.photos.filter(
      (p) => p.destination === draft.targetId,
    );
    for (const [index, item] of assigned.entries()) {
      const asset = session.photos.find((p) => p.id === item.assetId);
      const tile = el("div");
      tile.className = "av-review-photo";
      tile.append(...photo(asset), el("p", roleNames[item.role]));
      const use = el("input");
      use.type = "checkbox";
      const saved = packageChoice?.media.find((p) => p.assetId === asset.id);
      use.checked = Boolean(saved);
      use.onchange = packageDirty;
      const representative = el("input");
      representative.type = "radio";
      representative.name = "representative";
      representative.checked = Boolean(saved?.isRepresentative);
      const position = el("input");
      position.type = "number";
      position.min = "1";
      position.value = saved ? saved.position + 1 : index + 1;
      position.oninput = packageDirty;
      const useLabel = label("用于本次草稿", use);
      useLabel.className = "av-check";
      const representativeLabel = label("作为代表图", representative);
      representativeLabel.className = "av-check";
      representative.onchange = () => {
        use.checked = true;
        packageDirty();
      };
      tile.append(useLabel, representativeLabel, label("照片顺序", position));
      grid.append(tile);
      chosen.push({ asset, use, representative, position });
    }
    section.append(
      grid,
      button("使用已确认的资料准备卡片", () => {
        const media = chosen
          .filter((p) => p.use.checked)
          .map((p) => ({
            assetId: p.asset.id,
            position: Number(p.position.value) - 1,
            isRepresentative: p.representative.checked,
          }));
        if (!media.length || !kind.value || !title.value.trim()) {
          notice.textContent = "请填写标题、选择正式类型和照片。";
          return;
        }
        if (media.filter((p) => p.isRepresentative).length !== 1) {
          notice.textContent = "请选一张已勾选照片作为代表图。";
          return;
        }
        action("prepare-reviewed-package", {
          confirmed: true,
          choice: {
            objectId: draft.targetId,
            title: title.value,
            kind: kind.value,
            media,
          },
        });
      }),
    );
    root.append(section);
  }
  load().catch((error) => {
    notice.textContent = errors[error.message] || error.message;
  });
})();
