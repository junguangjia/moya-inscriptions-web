/* global document, location, URLSearchParams, fetch, setInterval, window, confirm */
(() => {
  "use strict";
  const q = (id) => document.getElementById(id);
  const material =
    new URLSearchParams(location.search).get("material") || "current";
  const csrf = document.cookie
    .split("; ")
    .find((x) => x.startsWith("curation_csrf="))
    ?.split("=")[1];
  let latest = null;
  let busy = false;
  const errors = {
    SYNTHETIC_PROVENANCE_REQUIRED:
      "合成资料的内容核验未通过，Development 传输已停止。请使用原始合成测试资料。",
    ANALYZED_FOLDER_CONTENTS_CHANGED:
      "这个已分析文件夹的照片清单已变化。为保护原对象和审核记录，请将新增照片放入新的小批文件夹，再选择分析；原对象仍可在资料库查看。",
    SYNCED_ANNOTATION_CHANGED:
      "这项审核已收集，后来又被编辑。请为本批创建新的审核版本；已有人工决定保留。",
    ANALYSIS_RUNNING: "正在分析这批资料，请等它完成或先取消。",
    SELECT_FOLDER_FIRST: "先选择一个照片文件夹。",
    BATCH_EXCEEDS_SELECTED_LIMIT:
      "这个文件夹超过本批上限。请选较小的文件夹，或明确提高上限后再分析。",
    NO_SUPPORTED_CANDIDATE_FILES: "所选文件夹没有支持的照片，请换一个文件夹。",
    NO_DECODABLE_ASSETS: "这批照片都未能读取，请查看格式与错误提示。",
    SOURCE_UNAVAILABLE_OR_OUTSIDE_SELECTION:
      "原资料目录不可用。外置盘可能已断开，请重新连接或重新选择。",
    EXPLICIT_BATCH_DIRECTORY_REQUIRED: "请选择具体的小批照片文件夹。",
    MODEL_TIMEOUT: "本机 AI 超时。已完成部分保留，可以继续分析。",
    MODEL_PROCESS_INCOMPLETE: "部分 AI 分析未完成。已有结果保留，可继续分析。",
    MODEL_STRUCTURE_INVALID:
      "AI 返回的结构不完整；未采纳这次输出。可继续尝试。",
    UNSUPPORTED_OR_CORRUPT_MEDIA: "照片格式暂不支持，或文件损坏。原文件保留。",
    STALE_REVIEW: "这份审核版本已过期。请打开对象当前的审核任务。",
    REVIEW_ALREADY_COLLECTED_IMMUTABLE:
      "这份审核已经收集。要修改结论，请为本批创建新的审核版本。",
    IMMUTABLE_DECISION: "已收集结论不会被覆盖。请创建新的审核版本。",
    GROUP_REVIEW_REQUIRED: "先审核并收集照片分组，再准备草稿。",
    KEY_FACT_REVIEW_REQUIRED: "还有关键资料待审核，请从缺项列表打开审核。",
    CURRENT_MEDIA_REVIEW_REQUIRED: "所选照片还需要在当前版本里审核并收集。",
    UNSUPPORTED_CATALOG_KIND:
      "请选择 ArtVenn 支持的正式类型：碑刻或书法。其他类型可继续留在本地整理。",
    PUBLIC_TITLE_REQUIRED: "填写你确认的公开标题。",
    PUBLIC_MEDIA_ORDER_OR_REPRESENTATIVE_INVALID:
      "照片顺序不能重复，并且需要选一张代表图。",
    REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED:
      "这批是真实资料，草稿只保留在本机。Development 验证仅允许合成测试资料。",
    PREPARE_PACKAGE_FIRST: "先准备 Synthetic 草稿文件包。",
    SOURCE_HASH_CHANGED:
      "原文件已发生变化，草稿准备已停止。请重新选择并分析这一批。",
    BATCH_LIMIT_INVALID: "本批上限需要是 1–1000 的整数。",
    OBJECT_SCOPE_INVALID: "这些对象不属于当前批次，请回工作台确认批次。",
    LOCAL_SESSION_OR_CSRF_REQUIRED: "本地会话已更新，请刷新页面后重试。",
  };
  const human = (code) =>
    errors[code] || "这一步未完成，已有工作保留。错误类别：" + code;
  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function notice(text, error = false) {
    q("notice").textContent = text;
    q("notice").classList.toggle("error", error);
  }
  function disable() {
    if (!latest) return;
    q("choose").disabled = busy || latest.running;
    q("synthetic").disabled = busy || latest.running;
    q("analyze").disabled =
      busy || latest.running || latest.viewOnly || !latest.selection.available;
    q("cancel").hidden = !latest.running;
    q("cancel").disabled = busy;
    q("collect").disabled = busy || latest.running || !latest.review.tasks;
    q("renew").disabled = busy || latest.running || !latest.review.tasks;
    q("open-draft").disabled = busy || latest.running || !latest.draftReady;
    q("development").disabled =
      busy || latest.running || !latest.prepared?.synthetic;
    q("review").setAttribute("aria-disabled", String(!latest.objects.length));
  }
  async function refresh() {
    try {
      const response = await fetch(
        "/dashboard?material=" + encodeURIComponent(material),
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.category || "LOCAL_SERVICE_UNAVAILABLE");
      latest = value;
      q("active-review").hidden = !value.activeReview;
      if (value.activeReview) {
        q("active-review-link").href = value.activeReview.url;
        const names = {
          draft: "填写已保存在本机，尚未确认",
          submitting: "正在保存或需要继续核对提交结果",
          submitted_waiting_collection: "审核已提交，正式收集尚未完成",
          collected: "正式决定已保存，可以选择草稿内容",
          package_prepared: "离线文件包已准备",
        };
        q("active-review-status").textContent =
          "本次仅 " +
          value.activeReview.photos +
          " 张 · " +
          (names[value.activeReview.state] || value.activeReview.state);
      }
      q("material").textContent =
        value.material === "synthetic"
          ? "SYNTHETIC FIXTURE / 合成测试"
          : "当前本机资料批次";
      q("folder").textContent = value.selection.name || "还没有选择资料";
      q("batch-detail").textContent = value.viewOnly
        ? "当前查看测试结果；你的本机资料选择仍保留。"
        : !value.selection.available
          ? "资料目录不可用，请连接原盘或重新选择文件夹。"
          : value.totals.files
            ? value.totals.files +
              " 张已检查 · " +
              value.objects.length +
              " 个候选对象 · 原图保留"
            : value.selection.count
              ? value.selection.overLimit
                ? "超过上次选择的照片上限；可选择小批次或明确提高上限。"
                : value.selection.count + " 张候选照片 · 点击开始分析"
              : "选择完成后，点击开始分析。";
      const phases = {
        unselected: "等待选择照片",
        selected: "可以开始分析",
        inspected: "照片已检查，可以继续分析",
        running: "正在启动分析…",
        inspecting: "正在检查照片和生成预览…",
        inferencing: "本机 AI 正在分析，请稍候…",
        review_ready: "AI 建议已准备好，下一步是人工审核",
        model_failed: "部分 AI 分析未完成，可以继续",
        failed: "分析未完成，已完成部分保留",
        cancelled_checkpoint_retained: "分析已取消，进度保留，可继续",
      };
      q("analysis-status").textContent = phases[value.phase] || "可以继续整理";
      q("analyze").textContent = [
        "failed",
        "model_failed",
        "cancelled_checkpoint_retained",
        "inspected",
      ].includes(value.phase)
        ? "继续未完成的分析"
        : value.phase === "review_ready"
          ? "重用本批已完成分析"
          : "开始分析";
      q("metrics").replaceChildren(
        ...[
          [value.totals.ready, "张可读取"],
          [value.totals.failed, "张读取失败"],
        ]
          .filter(([n]) => n)
          .map(([n, label]) => el("span", n + " " + label)),
      );
      q("failure-list").replaceChildren();
      for (const row of value.failures) {
        const p = el("p", row.count + " 张：" + human(row.category));
        p.className = "issue";
        q("failure-list").append(p);
      }
      if (value.error) {
        const p = el("p", human(value.error));
        p.className = "issue";
        q("failure-list").append(p);
      }
      q("review-status").textContent = value.review.tasks
        ? value.review.tasks +
          " 项审核 · " +
          (value.review.submitted === null
            ? "提交状态暂不可用"
            : value.review.submitted + " 项已提交") +
          " · " +
          value.review.collected +
          " 项已收集"
        : "分析后会生成审核任务";
      q("review").href = "/objects?scope=current&material=" + value.material;
      q("collect").textContent = value.review.waitingCollection
        ? "收集 " + value.review.waitingCollection + " 项已提交的决定"
        : "检查并收集本批决定";
      q("draft-status").textContent = value.prepared
        ? "本地草稿已准备：" +
          value.prepared.objects +
          " 个对象、" +
          value.prepared.media +
          " 张照片；未上传。"
        : value.draftReady
          ? value.draftReady + " 个对象已完成关键审核，可以选择草稿内容"
          : "先完成下面的关键审核，并收集决定";
      q("missing-reviews").replaceChildren();
      for (const object of value.objects.filter((o) => o.missing.length)) {
        const box = el("div");
        box.className = "issue";
        box.append(el("p", object.code + " · " + object.name));
        for (const missing of object.missing) {
          const link = el(
            missing.url ? "a" : "span",
            missing.label +
              (missing.status === "deferred"
                ? " · 已暂缓"
                : " · 待审核或待收集"),
          );
          if (missing.url)
            link.href =
              missing.url +
              (value.material === "synthetic" ? "&synthetic=1" : "");
          box.append(link);
        }
        q("missing-reviews").append(box);
      }
      disable();
    } catch (error) {
      notice(human(error.message), true);
    }
  }
  async function action(name, extra = {}) {
    if (busy) return;
    busy = true;
    disable();
    notice(
      name === "collect"
        ? "正在收集本批已提交的审核…"
        : name === "prepare"
          ? "正在生成并检查本地草稿…"
          : "正在执行，请稍候…",
    );
    try {
      const response = await fetch("/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          action: name,
          material,
          limit: Number(q("limit").value),
          ...extra,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.category || "ACTION_FAILED");
      if (name === "select" || name === "select-path" || name === "synthetic") {
        if (result.status !== "selection_cancelled" && material !== "current") {
          location.href = extra.syntheticOnly ? "/?material=synthetic" : "/";
          return;
        }
      }
      const messages = {
        selection_cancelled: "已取消选择，原批次保留。",
        selected_local_folder: "文件夹已选择。下一步点击开始分析。",
        selected_synthetic: "合成测试资料已选择。",
        running: "分析已开始。你可以继续浏览对象。",
        cancelled_checkpoint_retained: "分析已取消，已完成部分保留。",
        new_review_version_ready: "新的审核版本已准备；之前收集的结论保留。",
        stopping_persistent_data_retained:
          "本任务服务正在停止；数据保留。重新打开 App 即可继续。",
        development_draft_verified: "Synthetic Development Draft 已验证。",
      };
      if (result.status === "collected" || result.status === "partial")
        notice(
          "本次收集 " +
            result.new_decisions +
            " 项新决定。" +
            (result.failures?.length
              ? result.failures.map(human).join("；")
              : "已有决定保留；重复收集不会重复写入。"),
          !!result.failures?.length,
        );
      else if (result.status === "package_prepared")
        notice(
          "本地 Draft 文件包已准备：" +
            result.objects +
            " 个对象、" +
            result.media +
            " 张照片。可在 App 菜单里打开草稿目录。真实资料未外发。",
        );
      else if (result.status === "development_partial")
        notice(
          "Synthetic Development 仅完成 " +
            result.succeeded +
            " 项，" +
            result.failed +
            " 项失败。已有回执保留；修正问题后点击验证，可继续失败部分。",
          true,
        );
      else notice(messages[result.status] || "操作完成。");
      if (name !== "stop") await refresh();
    } catch (error) {
      notice(human(error.message), true);
    } finally {
      busy = false;
      disable();
    }
  }
  q("choose").onclick = () => {
    if (window.webkit?.messageHandlers?.selectFolder)
      window.webkit.messageHandlers.selectFolder.postMessage({
        action: "choose",
      });
    else action("select");
  };
  window.artvennFolderChosen = (path, syntheticOnly = false) =>
    action("select-path", { path, syntheticOnly });
  window.artvennFolderCancelled = () => notice("已取消选择，原批次保留。");
  q("analyze").onclick = () => action("analyze");
  q("cancel").onclick = () => action("cancel");
  q("collect").onclick = () => action("collect");
  q("synthetic").onclick = () => {
    if (confirm("切换到明确标记的合成测试资料？已有本机对象和审核记录会保留。"))
      action("synthetic");
  };
  q("renew").onclick = () => {
    if (
      confirm(
        "为当前这批对象创建新的审核版本？已收集的决定会保留，新版本需要重新审核。",
      )
    )
      action("renew-review", { confirmed: true });
  };
  q("development").onclick = () => action("development");
  q("stop").onclick = () => {
    if (confirm("停止本任务的分析和本地服务？照片、审核记录与进度都会保留。"))
      action("stop");
  };
  async function loadSelection() {
    const response = await fetch(
      "/selection?material=" + encodeURIComponent(material),
    );
    const value = await response.json();
    if (!response.ok) {
      notice(human(value.category), true);
      return;
    }
    const root = q("selection");
    root.hidden = false;
    root.replaceChildren();
    for (const object of value.objects) {
      const card = el("section");
      card.className = "draft-object";
      card.dataset.object = object.id;
      const use = el("input");
      use.type = "checkbox";
      use.className = "use";
      use.disabled = !!object.missing.length;
      const useLabel = el("label");
      useLabel.append(use, " 选择 " + object.code + " · " + object.name);
      card.append(useLabel);
      if (object.missing.length) {
        card.append(el("p", "先完成关键审核并收集决定，再选择这个对象。"));
        root.append(card);
        continue;
      }
      const titleLabel = el("label", "确认公开标题 ");
      const title = el("input");
      title.value = object.title;
      title.className = "title";
      titleLabel.append(title);
      card.append(titleLabel);
      const kindLabel = el("label", "正式类型 ");
      const kind = el("select");
      kind.className = "kind";
      for (const [key, label] of [
        ["", "请选择"],
        ["inscription", "碑刻"],
        ["calligraphy", "书法"],
      ]) {
        const option = el("option", label);
        option.value = key;
        kind.append(option);
      }
      kindLabel.append(kind);
      card.append(kindLabel);
      const photos = el("div");
      photos.className = "draft-photos";
      for (const asset of object.assets) {
        const item = el("div");
        item.className = "draft-photo";
        const check = el("input");
        check.type = "checkbox";
        check.className = "media";
        check.dataset.asset = asset.id;
        const label = el("label");
        label.append(check, " 用于草稿");
        const image = el("img");
        image.src = asset.url;
        image.alt = "选择草稿照片";
        const role = {
          overview: "整体图",
          detail: "细节",
          label: "展签",
          context: "环境",
          unspecified: "用途未指定",
        };
        const orderLabel = el("label", "顺序 ");
        const order = el("input");
        order.type = "number";
        order.min = "0";
        order.value = asset.position;
        order.className = "order";
        orderLabel.append(order);
        const repLabel = el("label", "代表图 ");
        const rep = el("input");
        rep.type = "radio";
        rep.name = object.id;
        rep.className = "representative";
        repLabel.append(rep);
        item.append(
          label,
          image,
          el("p", role[asset.role] || asset.role),
          orderLabel,
          repLabel,
        );
        photos.append(item);
      }
      card.append(photos, el("p", "照片均需明确勾选；展签和证据图默认不选。"));
      root.append(card);
    }
    const prepare = el("button", "确认选择，准备本地 Draft 文件包");
    prepare.onclick = () => {
      const objects = [...root.querySelectorAll(".draft-object")]
        .filter((c) => c.querySelector(".use").checked)
        .map((c) => ({
          objectId: c.dataset.object,
          title: c.querySelector(".title").value,
          kind: c.querySelector(".kind").value,
          media: [...c.querySelectorAll(".draft-photo")]
            .filter((p) => p.querySelector(".media").checked)
            .map((p) => ({
              assetId: p.querySelector(".media").dataset.asset,
              position: Number(p.querySelector(".order").value),
              isRepresentative: p.querySelector(".representative").checked,
            })),
        }));
      if (!objects.length) {
        notice("先选择至少一个已审核对象。", true);
        return;
      }
      action("prepare", { objects });
    };
    root.append(prepare);
  }
  q("open-draft").onclick = () =>
    loadSelection().catch((error) => notice(human(error.message), true));
  refresh();
  setInterval(refresh, 3000);
})();
