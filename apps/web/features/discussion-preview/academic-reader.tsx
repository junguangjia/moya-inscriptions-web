"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { previewSpecials } from "./preview-data";
import styles from "./academic-reader.module.css";

type AcademicSpecial = (typeof previewSpecials)[number];
type Chapter = {
  readonly title: string;
  readonly paragraphs: readonly string[];
};
/** One figure placed after a paragraph of a chapter. */
export interface AcademicFigure {
  readonly afterParagraph: number;
  readonly src: string;
  readonly alt: string;
  readonly caption: string;
}
export interface AcademicChapterView extends Chapter {
  readonly figures?: readonly AcademicFigure[];
}
/**
 * Presentation input of the academic reader. Real Articles map to it from the
 * editorial API; the local preview maps its fixtures to the same shape.
 */
export interface AcademicArticleView {
  readonly id: string;
  readonly category: string | null;
  readonly title: string;
  readonly subtitle: string | null;
  readonly byline: string;
  readonly meta: string;
  readonly intro: string | null;
  readonly chapters: readonly AcademicChapterView[];
  /** Citation lines shown in the footer; the second element is a source note. */
  readonly citation: readonly [string, string | null];
}

// Presentation copy for the local preview; no publication or backend identity.
const chaptersBySpecial: Record<AcademicSpecial["id"], readonly Chapter[]> = {
  "special-stone": [
    {
      title: "问题的起点：我们在阅读什么",
      paragraphs: [
        "面对一方题刻，阅读对象并不只有可以转录的文字。石面的尺度与位置、文字周围的留白、图像的制作条件，都会参与读者对材料的理解。因此，在比较原石、拓片和数字图像之前，需要先说明：本次观察试图回答什么问题，又依据哪一种材料展开。",
        "本文以材料之间的转换为线索，将研究过程分为记录、比较与解释三个层次。记录描述能够复核的可见现象；比较说明材料之间的异同；解释则提出这些差异可能意味着什么。三个层次彼此联系，但不宜用解释替代记录。",
      ],
    },
    {
      title: "材料范围与来源说明",
      paragraphs: [
        "为一组碑刻图像建立材料表时，可以分别记录对象名称、拍摄或制作时间、收藏与提供机构，以及本次使用的图像版本。若来源信息尚不完整，应保留空缺与待核说明，而不是凭画面风格推定年代或制作人。",
        "同一对象的不同图像不能自动视作同一份证据。局部照片、整幅拓片和经过裁切的数字图像各有边界。比较之前，应确认它们覆盖的区域是否重合，比例是否一致，画面中的明暗是否受到额外处理。",
      ],
    },
    {
      title: "从原石到纸：图像的生成条件",
      paragraphs: [
        "原石上的凹凸关系进入纸面之后，需要借助另一套明暗与边缘来表现。阅读时既要关注字形，也要留意制作过程留下的痕迹。某处墨色的变化，可以作为进一步观察的线索，却不能单独证明笔画或石面的变化。",
        "将拓片与现场照片并置时，宜先找到稳定的对应点，再逐步核对字口、裂隙和缺损区域。比较说明中应明确每一种图像能够呈现什么、暂时不能回答什么，使读者能够区分材料限制与释读者的判断。",
      ],
    },
    {
      title: "局部比较与释读边界",
      paragraphs: [
        "对残字的讨论可以从可见笔画开始：描述方向、相交关系和缺损位置，再讨论可能的结构。此时，相邻文字、行列布局与整篇语境可以提供帮助，但它们应作为不同层次的依据分别列出。",
        "若两种读法都与现有图像相容，较稳妥的写法是保留并列解释，并指出能够区分它们的新增材料。把不确定性写清楚，并不削弱讨论；它为下一次观察规定了更具体的任务。",
      ],
    },
    {
      title: "数字整理与可复核的阅读路径",
      paragraphs: [
        "数字整理的重点不只是得到清晰的图像，还在于保存从结论返回材料的路径。全文、局部和释文之间应有稳定的对应关系；图像的裁切、旋转或对比度调整也应留下说明，以便读者理解当前版本的呈现条件。",
        "一条可复核的记录，可以包含原始材料位置、关注区域、观察描述与讨论版本。后续修订改变了解释时，仍保留此前引用的材料位置，使新的判断能够与旧的观察直接比较。",
      ],
    },
    {
      title: "结语：让解释回到材料",
      paragraphs: [
        "原石、纸本与数字图像为同一对象提供了不同的观看入口。它们之间的关系不能简化为清晰程度的排序，而应结合具体问题，讨论每一种材料提供的信息与可能的限制。",
        "本文提出的阅读顺序，是先交代材料，再陈述观察，最后展开解释。结论仍应允许被新增材料修正；研究的连续性，正建立在这些可以重新进入、继续核对的细节之上。",
      ],
    },
  ],
  "special-writing": [
    {
      title: "研究问题：从单字走向整篇",
      paragraphs: [
        "单字的点画容易成为观看与临写的中心，但一件作品的形式关系还发生在字与字、行与行之间。本文把观察尺度作为讨论线索，尝试说明局部结构如何进入整篇章法，以及观看与书写如何相互提出问题。",
        "这里的比较不为不同作品建立优劣次序，而是明确每一次观察的对象。讨论字内空间时，所依据的是笔画与空白的关系；讨论行间节奏时，则需要把单字放回相邻文字与整页布局之中。",
      ],
    },
    {
      title: "材料选择与比较条件",
      paragraphs: [
        "选择用于比较的作品图像时，应先核对来源、尺寸信息和画面完整性。裁切后的局部适合观察细节，却不能直接代替整件作品的章法；经过缩放的图像，也需要说明观看尺度与原物尺度的区别。",
        "临写记录可以与观看笔记并列保存。记录中注明材料、工具、日期与关注问题，有助于区分不同次练习的条件。比较应围绕同一个明确问题展开，避免把条件差异笼统归结为书写能力的变化。",
      ],
    },
    {
      title: "字内空间：笔画与留白",
      paragraphs: [
        "观察一个字时，可以先暂缓为某一笔命名，转而描述笔画之间形成的空间。空白的宽窄、开合与方向，提供了一条理解结构的路径。这样的描述需要同时照顾笔画本身，避免把留白理解成独立于书写的几何图形。",
        "局部比较宜选择对应区域，并说明两者的共同条件。若一个转折在缩小图像后不再突出，可以进一步讨论它在整字中的作用，而不必立即认定局部判断与整体判断彼此矛盾。",
      ],
    },
    {
      title: "行间关系与整页节奏",
      paragraphs: [
        "把视线从单字移向整行，可以观察字的大小、重心与间距如何连续变化。再把数行并置，行间空白与边界便进入讨论。描述这些关系时，宜指出具体位置，而不是只用疏、密、紧、松概括整幅作品。",
        "观看尺度的切换有助于校验局部印象。先在整页上标出关注区域，再返回原比例观察细节，可以使一次判断保留其上下文。若局部效果未在整体中形成同样的感受，也应把这一差异写入笔记。",
      ],
    },
    {
      title: "临写作为观察的延伸",
      paragraphs: [
        "临写会把观看时尚不明显的问题带入动作过程。某个转折需要怎样的行笔衔接，某段连贯关系依靠怎样的停顿，这些问题可以在练习后再次返回图像核对。动作感受是讨论的材料之一，但不应直接替代对作品的描述。",
        "持续记录同一片段的练习，比只保留一次完成稿更便于比较。每次记录一个具体问题、相应尝试和仍未解决的部分，可以逐步形成可追溯的学习过程，而不是仅为每一次临写写下总评。",
      ],
    },
    {
      title: "结语：保存尺度之间的联系",
      paragraphs: [
        "从单字到整篇的阅读，不是把局部判断简单放大，而是在不同尺度上重新确认对象之间的关系。字内空间、行间呼应与整页留白可以分别描述，再通过具体位置建立联系。",
        "观看与临写的往返，为这一过程提供了持续修订的机会。本文建议把材料说明、局部观察和实践记录共同保留，让每一次新的理解，都能够返回此前的问题与证据。",
      ],
    },
  ],
  "special-field": [
    {
      title: "问题意识：题刻与所在之地",
      paragraphs: [
        "题刻能够被转录为文字，也能够被记录为图像，但这些形式并未包含现场的全部关系。本文关注题刻的位置、观看路径与环境条件，讨论如何在记录文字之外，为后续阅读保留必要的空间语境。",
        "现场记录不必一次完成所有解释。更可行的起点，是明确本次观察的范围：哪些关系可以直接记录，哪些判断需要再次测量，哪些问题还需借助其他文献或更早的图像核对。",
      ],
    },
    {
      title: "进入现场：范围与记录顺序",
      paragraphs: [
        "记录可以从通向题刻的路径开始，再逐步进入环境、石面全貌与文字局部。这样的顺序便于说明观察者如何抵达对象，也能帮助未曾到场的读者建立整体与局部之间的对应关系。",
        "每一次记录应注明日期、可到达范围和观察限制。若某一区域无法接近，可以保留远距离图像与限制说明，不宜用推测补齐细节。清楚的边界，有助于安排后续的补充观察。",
      ],
    },
    {
      title: "位置与尺度：把对象放回空间",
      paragraphs: [
        "题刻与山体、道路、水流或其他刻石的相对位置，是现场记录的一部分。描述这些关系时，可以结合方向、距离与示意图，并区分实测数据和目测判断，以免读者把估计值误作精确测量。",
        "图像中的尺度参照应说明其所在平面及使用方式。一个只出现在近景中的参照物，未必适合直接解释整面石壁的尺寸。记录方法与结论的适用范围，需要一起呈现。",
      ],
    },
    {
      title: "光照、石面与观察条件",
      paragraphs: [
        "同一区域在不同光照与观看方向下，可能呈现不同的明暗边界。比较图像时，应先确认拍摄位置与光线条件，避免把呈现差异直接理解为对象本身的变化。",
        "对于疑似笔画、裂隙或缺损边缘，可以分别保留整体定位图和局部观察图。描述时先陈述可见形态，再说明判断依据；若现有记录不足以区分几种解释，应明确列出需要补充的观察条件。",
      ],
    },
    {
      title: "从现场笔记到共享材料",
      paragraphs: [
        "整理阶段应保留现场记录的顺序和对应关系，使照片、示意图与文字笔记能够相互定位。图像说明不仅写明拍摄对象，也可以指出关注区域、观察方向以及与其他记录的关系。",
        "共享材料时，需要把原始观察与整理后的解释区分开来。后续研究者即使不接受某项解释，仍应能够识别它依据的图像和记录。这样的资料结构为讨论与修订留下了共同入口。",
      ],
    },
    {
      title: "结语：为下一次重访留下问题",
      paragraphs: [
        "现场工作的价值不仅体现在一次记录的完整程度，也体现在它是否使下一次观察更为明确。把未知部分转化为具体问题，能够帮助重访者选择位置、时间和需要补充的材料。",
        "本文建议以范围说明、空间关系和观察条件组织现场笔记。题刻由此不再只是一幅孤立的文字图像，而成为可以沿着记录路径反复进入、逐步理解的研究对象。",
      ],
    },
  ],
  "special-album": [
    {
      title: "册页作为连续的观看对象",
      paragraphs: [
        "一页册页可以独立呈现图像与文字，也处在翻阅形成的次序之中。讨论装帧与观看的关系，需要同时关注单页布局、前后页的呼应和整册的组织方式。若只选取最醒目的一页，研究对象的边界也随之改变。",
        "本文把页与页之间的联系作为问题的起点。首先记录现存材料的排列，再描述图像、题跋与留白的分布，最后讨论这些关系如何参与阅读。现存顺序与最初编排是否相同，仍需要其他材料支持，不能仅凭观看感受决定。",
      ],
    },
    {
      title: "装帧、页序与版本说明",
      paragraphs: [
        "整理册页时，可以分别记录封面、题签、正文页、题跋与其他附属材料，并保留空白页和缺页说明。页码用于定位当前材料，不应在未经核对时被理解为作品原有的编号。",
        "若同时使用出版图录与数字图像，需要说明两者收录范围和排列是否一致。裁边、拼页或跨页展示都可能改变读者感知到的邻接关系。比较说明应交代所用版本，使不同读者能够返回同一组材料。",
      ],
    },
    {
      title: "单页内部：图像、文字与留白",
      paragraphs: [
        "在单页层面，可以从图像与题字的位置、尺度和相互距离入手。描述留白时，应指出它处在页边、图文之间还是主体内部，并说明判断依据，避免把不同位置的空白归入同一种形式作用。",
        "观察还应保留整页与局部的对应。一个醒目的题跋细节可能引导阅读，但它在全页中的分量，需要结合周围图像和其他文字重新判断。局部放大适合辨认，整页记录则保留构成关系。",
      ],
    },
    {
      title: "翻页之间的呼应与间隔",
      paragraphs: [
        "连续翻阅时，前一页留下的印象会与后一页发生联系。研究者可以具体描述重复出现的形态、相邻页的尺度变化和图文位置的差别，再讨论这种排列如何影响阅读节奏。",
        "对于无法确认的原始页序，可以建立几种排列假设，但应将假设与现存装订分开标注。不同顺序带来的观看差异能够提出问题，却不能单独证明哪一种排列更早或更接近编者意图。",
      ],
    },
    {
      title: "题跋与编排：不同层次的证据",
      paragraphs: [
        "题跋中的时间、名称与流传说明，可以为理解册页提供线索。引用这些内容时，应区分文字明确陈述的信息、研究者据此作出的推断，以及还需要外部材料核对的部分。",
        "装帧痕迹、图像关系与题跋文字并不必然指向同一结论。较清楚的讨论方式，是逐项列出依据及其适用范围，再说明它们之间的支持、差异或空缺，而不是把多个线索合并成一个未经展开的故事。",
      ],
    },
    {
      title: "结语：保存一册的阅读路径",
      paragraphs: [
        "册页的整理需要兼顾单页的完整性和页序的可见性。稳定的页码、清楚的版本说明和整册浏览路径，使读者能够在细节与连续观看之间往返。",
        "本文建议在图像之外保留编排说明与待核问题。册页由此既是一组可以逐页研究的材料，也是一种能够反复检验其观看关系的整体。",
      ],
    },
  ],
  "special-trace": [
    {
      title: "残损材料与研究问题的边界",
      paragraphs: [
        "面对不完整的材料，研究首先需要说明完整性缺失发生在哪里：是对象本身已有残损，还是当前图像未能覆盖全部区域。二者可能同时存在，却要求不同的补充观察。",
        "本文从描述方法出发，讨论如何把可见痕迹、比较依据与释读意见分别记录。目的不是迅速填补所有空缺，而是让每一个判断保留能够返回材料的路径。",
      ],
    },
    {
      title: "建立可定位的痕迹记录",
      paragraphs: [
        "记录一处痕迹时，可以先指出它在整体中的位置，再描述走向、范围及其与相邻形态的关系。统一的位置标记有助于多人讨论同一区域，也能减少单凭局部截图产生的指认偏差。",
        "描述应尽可能先使用可观察的形态语言。当某条边界尚不能确定为笔画、裂隙或制作痕迹时，可以保留中性的称谓，同时列出拟议解释。名称的选择本身不应预先完成论证。",
      ],
    },
    {
      title: "比较图像之前的条件核对",
      paragraphs: [
        "不同时期或方式形成的图像，为释读提供了比较机会。进入细节之前，需要核对对象、覆盖区域、尺度及图像处理情况。只有明确这些条件，才能说明画面差异可能对应哪一类问题。",
        "若某处痕迹只在一张图像中可见，可以先检查拍摄角度与明暗，再考虑其他解释。材料之间的不一致值得保留，它既可能提示对象的变化，也可能揭示记录方式的限制。",
      ],
    },
    {
      title: "从形态描述到释读假设",
      paragraphs: [
        "释读可以结合字形结构、相邻文字和语境，但这些依据宜分别展开。由可见笔画支持的部分，与依靠上下文补出的部分，应在说明中清楚区分，让读者能够评价每一步推论。",
        "当多个假设都与现有材料相容时，可以并列呈现它们，并指出各自需要满足的条件。保留不同可能性，不是取消判断，而是把判断的范围限定在证据真正能够支持的位置。",
      ],
    },
    {
      title: "不确定性的标注与修订",
      paragraphs: [
        "标注方式应在同一份记录中保持一致，并附有简短说明。待核、缺失和无法辨认是不同状态，若采用同一个符号表示，后续读者可能无法了解记录者当时掌握的情况。",
        "新增图像改变了释读时，应保留修订依据与此前引用的位置。版本记录不必保留所有操作细节，但需要说明结论为什么发生变化，以及仍然没有解决的问题。",
      ],
    },
    {
      title: "结语：让空缺保持可讨论",
      paragraphs: [
        "残损材料的研究依赖细致的描述，也依赖对推论范围的自觉控制。清楚的记录使不同意见能够围绕同一位置与同一组证据展开，而不是停留在互不相接的结论之间。",
        "本文建议把每一处空缺转化为可继续工作的提问：需要哪一种图像、哪一组比较或哪一项现场观察。空缺由此成为后续研究的入口。",
      ],
    },
  ],
  "special-landscape": [
    {
      title: "文字如何进入山水空间",
      paragraphs: [
        "题刻在图像中常被呈现为一块独立的文字区域，而在现场，它还与地形、路径和观看者的位置相连。本文讨论这些空间关系怎样进入记录，以及它们能够为阅读提出什么问题。",
        "将文字放回环境，并不意味着仅凭位置就能解释其全部意义。更具体的做法，是区分可以记录的空间现象、关于观看方式的推测，以及需要文献支持的历史判断。",
      ],
    },
    {
      title: "研究范围与空间材料",
      paragraphs: [
        "一组空间记录可以包括位置示意、到达路径、环境全景与题刻近景。材料之间应能够相互定位，使读者理解局部图像对应的方向和区域。若某一段路径无法记录，应说明实际观察的边界。",
        "使用地图、旧照片或游记辅助讨论时，需要注明它们各自的时间与覆盖范围。不同材料呈现的空间尺度未必一致，不能因为名称相近就直接把它们视为同一个位置的描述。",
      ],
    },
    {
      title: "观看距离与可见性",
      paragraphs: [
        "从远处辨认题刻所在区域，与近距离阅读文字，是两种不同的观察任务。记录可以说明在何处开始看见对象、在哪些位置能够辨认细节，以及其间的视线是否受到遮挡。",
        "可见性还受到当时环境条件的影响。一次观察只能说明特定条件下的所见，若要讨论更稳定的观看关系，还需要不同时间或位置的补充记录。",
      ],
    },
    {
      title: "路径、停留与阅读次序",
      paragraphs: [
        "沿不同路径接近同一题刻，进入视野的顺序可能不同。研究者可以记录转折点、停留位置与视线方向，再讨论这些关系如何组织一次具体的观看经历。",
        "观察者今天采用的路线不应自动等同于历史路径。若要把两者联系起来，需要相应材料说明路径的变化与延续。当前经验能够帮助提出问题，但仍须与历史判断分开书写。",
      ],
    },
    {
      title: "地方叙述与图像的对读",
      paragraphs: [
        "地方叙述可能为题刻的位置和名称提供线索，图像则保留某次记录中的可见状态。对读时，可以逐项列出两种材料明确说明的内容，以及暂时无法对应的部分。",
        "当文字叙述与当前所见存在差异时，差异本身应成为讨论对象。可以检查记录时间、观察范围与用语含义，而不急于用其中一种材料覆盖另一种。",
      ],
    },
    {
      title: "结语：连接文字与观看的位置",
      paragraphs: [
        "空间研究为题刻阅读增加了位置与路径的维度，同时要求研究者更清楚地说明观察条件。文字、图像与环境记录之间的联系，宜通过可定位的材料逐步建立。",
        "本文建议保留从环境到局部、从路径到文字的往返入口。这样的整理使山水中的文字能够被重新放回观看的位置，也为后续的历史讨论提供边界清楚的依据。",
      ],
    },
  ],
};

const illustrations: Record<string, readonly [string, string]> = {
  "special-stone": ["rubbing-fragment.svg", "拓片局部与石面痕迹的对应关系"],
  "special-writing": ["ink-album.svg", "从单页布局观察笔墨与留白"],
  "special-field": ["stone-detail.svg", "现场记录中的石面局部"],
  "special-album": ["calligraphy-sheet.svg", "册页中单页图文的组织方式"],
  "special-trace": ["inscription-rubbing.svg", "比较材料中的字形与残损区域"],
  "special-landscape": ["cliff-gate.svg", "山体与题刻观看路径的关系"],
};

type Scrub = {
  readonly pointerId: number;
  cancelled: boolean;
};

/** Preview fixtures rendered through the same reader as real Articles. */
export const academicViewFromSpecial = (
  special: AcademicSpecial,
): AcademicArticleView => {
  const chapters =
    chaptersBySpecial[special.id] ?? chaptersBySpecial["special-stone"]!;
  const illustration =
    illustrations[special.id] ?? illustrations["special-stone"]!;
  return {
    id: special.id,
    category: special.category,
    title: special.title,
    subtitle: special.subtitle,
    byline: "由艺编辑室",
    meta: `${special.issue} · 研究札记 · 约 8 分钟`,
    intro: special.intro,
    chapters: chapters.map((chapter, index) => ({
      ...chapter,
      figures:
        index === 1
          ? [
              {
                afterParagraph: 0,
                src: special.image,
                alt: `${special.title}的材料关系示意图`,
                caption: `图 1 · ${special.subtitle}（示意）`,
              },
            ]
          : index === 3
            ? [
                {
                  afterParagraph: 0,
                  src: `/docs/design-system/assets/demo/${illustration[0]}`,
                  alt: illustration[1],
                  caption: `图 2 · ${illustration[1]}（示意）`,
                },
              ]
            : [],
    })),
    citation: [
      `由艺编辑室：《${special.title}——${special.subtitle}》，由艺学术专题，${special.issue}，前端示例版。`,
      "本文为阅读体验示例，未作为正式学术文献发表。引用具体论述时，请核对原始材料与正式出版来源。",
    ],
  };
};

export function AcademicReader({
  article: special,
  scrollElement,
  active = true,
  railPortalTarget,
}: {
  readonly article: AcademicArticleView;
  /** Omit for a standalone reader; null waits for the parent reading panel. */
  readonly scrollElement?: HTMLElement | null;
  readonly active?: boolean;
  /** Embedded navigation belongs outside the transformed horizontal track. */
  readonly railPortalTarget?: HTMLElement | null;
}) {
  const chapters = special.chapters;
  const embedded = scrollElement !== undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const chapterNodes = useRef<(HTMLElement | null)[]>([]);
  const rail = useRef<HTMLElement>(null);
  const scrub = useRef<Scrub | null>(null);
  const [inBody, setInBody] = useState(false);
  const [activeChapter, setActiveChapter] = useState(0);
  const [previewPosition, setPreviewPosition] = useState<number | null>(null);
  const previewChapter =
    previewPosition === null ? null : Math.round(previewPosition);
  const chapterId = (index: number) => `${special.id}-chapter-${index + 1}`;
  const scrollOwner = () => (embedded ? scrollElement : scroller.current);
  const scrollPadding = () => {
    const node = scrollOwner();
    if (!node) return 0;
    return Number.parseFloat(getComputedStyle(node).scrollPaddingTop) || 0;
  };
  const measure = () => {
    const node = scrollOwner();
    if (!node || !body.current || !active) return;
    const boundary = node.getBoundingClientRect().top + scrollPadding();
    const entered =
      body.current.getBoundingClientRect().top <= boundary &&
      (article.current?.getBoundingClientRect().bottom ?? Infinity) > boundary;
    setInBody(entered);
    let current = 0;
    chapterNodes.current.forEach((chapter, index) => {
      if (chapter && chapter.getBoundingClientRect().top <= boundary + 1)
        current = index;
    });
    setActiveChapter(current);
    if (!entered) {
      scrub.current = null;
      setPreviewPosition(null);
    }
  };

  useLayoutEffect(() => {
    // The shared article container owns position restoration in embedded mode.
    if (!embedded && scroller.current) scroller.current.scrollTop = 0;
  }, [special.id, embedded]);

  useLayoutEffect(() => {
    if (!active) {
      scrub.current = null;
      setPreviewPosition(null);
      setInBody(false);
      return;
    }
    const node = scrollOwner();
    if (!node) return;
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    if (body.current) observer?.observe(body.current);
    chapterNodes.current.forEach(
      (chapter) => chapter && observer?.observe(chapter),
    );
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [special.id, scrollElement, active]);

  const jumpTo = (index: number, focus = false) => {
    const node = scrollOwner();
    const chapter = chapterNodes.current[index];
    if (!node || !chapter || !active) return;
    const top =
      node.scrollTop +
      chapter.getBoundingClientRect().top -
      node.getBoundingClientRect().top -
      scrollPadding();
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    node.scrollTo({
      top: Math.max(0, top),
      behavior: reduced ? "auto" : "smooth",
    });
    if (focus)
      chapter.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  };

  const positionAt = (clientX: number, clientY: number) => {
    const bounds = rail.current?.getBoundingClientRect();
    if (
      !bounds ||
      bounds.height === 0 ||
      clientX < bounds.left ||
      clientX > bounds.right ||
      clientY < bounds.top ||
      clientY > bounds.bottom
    )
      return null;
    return Math.max(
      0,
      Math.min(
        chapters.length - 1,
        ((clientY - bounds.top) / bounds.height) * chapters.length - 0.5,
      ),
    );
  };

  const clearScrub = (event: PointerEvent<HTMLElement>) => {
    if (scrub.current?.pointerId !== event.pointerId) return;
    scrub.current = null;
    setPreviewPosition(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancelPreview = () => {
    if (scrub.current) scrub.current.cancelled = true;
    setPreviewPosition(null);
  };
  const startScrub = (event: PointerEvent<HTMLElement>) => {
    if (
      !active ||
      event.button !== 0 ||
      event.isPrimary === false ||
      scrub.current
    )
      return;
    const position = positionAt(event.clientX, event.clientY);
    if (position === null) return;
    event.preventDefault();
    event.stopPropagation();
    scrub.current = {
      pointerId: event.pointerId,
      cancelled: false,
    };
    setPreviewPosition(position);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an enhancement. The enlarged rail remains usable in
      // browsers that reject capture while the pointer stays inside its bounds.
    }
  };
  const moveScrub = (event: PointerEvent<HTMLElement>) => {
    const session = scrub.current;
    if (!session || session.pointerId !== event.pointerId || session.cancelled)
      return;
    event.preventDefault();
    event.stopPropagation();
    const position = positionAt(event.clientX, event.clientY);
    if (position === null) cancelPreview();
    else {
      setPreviewPosition(position);
    }
  };
  const finishScrub = (event: PointerEvent<HTMLElement>) => {
    const session = scrub.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const position = session.cancelled
      ? null
      : positionAt(event.clientX, event.clientY);
    // Use the release coordinate as the final slider value. Pointer-event
    // implementations may coalesce the last move before pointerup.
    const index = position === null ? null : Math.round(position);
    clearScrub(event);
    if (index !== null) jumpTo(index);
  };
  const moveKeyboardFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.max(
              0,
              Math.min(
                buttons.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
    buttons[next]?.focus();
  };

  const navigation =
    inBody && active && (!embedded || railPortalTarget) ? (
      <nav
        ref={rail}
        className={styles.rail}
        aria-label="章节导航"
        data-academic-rail=""
        data-active-chapter={activeChapter}
        data-preview-chapter={previewChapter ?? undefined}
        data-scrubbing={String(previewPosition !== null)}
        onPointerDown={startScrub}
        onPointerMove={moveScrub}
        onPointerUp={finishScrub}
        onPointerCancel={clearScrub}
        onLostPointerCapture={(event) => {
          // Touch begins with implicit capture on the nested dot button.
          // Moving capture to this rail releases that descendant, not this drag.
          if (event.target === event.currentTarget) clearScrub(event);
        }}
        onPointerLeave={(event) => {
          if (scrub.current?.pointerId === event.pointerId) cancelPreview();
        }}
        onKeyDown={moveKeyboardFocus}
      >
        {chapters.map((chapter, index) => {
          const selectedDistance =
            previewChapter === null
              ? Infinity
              : Math.abs(index - previewChapter);
          const pointerDistance =
            previewPosition === null
              ? Infinity
              : Math.abs(index - previewPosition);
          const proximity = Math.max(0, 1 - pointerDistance / 2);
          const selected = previewChapter === index;
          const visible = previewChapter !== null && selectedDistance <= 1;
          return (
            <button
              key={chapter.title}
              type="button"
              aria-label={`第 ${index + 1} 节：${chapter.title}`}
              aria-controls={chapterId(index)}
              aria-current={activeChapter === index ? "location" : undefined}
              data-academic-rail-index={index}
              data-previewed={String(selected)}
              style={
                {
                  // The selected chapter is always uniquely largest. Nearby
                  // items still follow the finger continuously like a Dock.
                  "--chapter-label-scale": selected
                    ? 1.16
                    : 0.78 + proximity * 0.24,
                  "--chapter-label-opacity": selected
                    ? 1
                    : visible
                      ? 0.34 + proximity * 0.46
                      : 0,
                  "--chapter-dot-scale": selected ? 1.7 : 1 + proximity * 0.46,
                } as CSSProperties
              }
              onClick={(event) => {
                if (event.detail === 0) jumpTo(index, true);
              }}
            >
              <span className={styles.railDot} aria-hidden="true" />
              <span
                className={styles.railLabel}
                aria-hidden="true"
                data-academic-rail-label={index}
                data-visible={String(visible)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {chapter.title}
              </span>
            </button>
          );
        })}
        {previewChapter !== null && (
          <output
            className={styles.visuallyHidden}
            data-academic-rail-preview=""
            aria-live="polite"
          >
            {`${previewChapter + 1} ${chapters[previewChapter]?.title}`}
          </output>
        )}
      </nav>
    ) : null;

  return (
    <div
      ref={scroller}
      className={styles.reader}
      data-academic-reader={special.id}
      data-academic-content=""
      data-academic-scroll={embedded ? undefined : ""}
      data-academic-embedded={String(embedded)}
      data-academic-in-body={String(inBody)}
      role={embedded ? undefined : "region"}
      aria-label={embedded ? undefined : `${special.title}正文`}
      tabIndex={embedded ? undefined : 0}
    >
      <article
        ref={article}
        className={styles.article}
        aria-labelledby={`${special.id}-reader-heading`}
      >
        <header className={styles.header}>
          {special.category && (
            <p className={styles.category}>{special.category}</p>
          )}
          <h2 id={`${special.id}-reader-heading`}>
            {special.title}
            {special.subtitle && <span>{special.subtitle}</span>}
          </h2>
          <p className={styles.author}>{special.byline}</p>
          <p className={styles.meta}>{special.meta}</p>
        </header>
        {special.intro && (
          <section className={styles.abstract} aria-label="摘要">
            <h3>摘要</h3>
            <p>{special.intro}</p>
          </section>
        )}
        <nav
          className={styles.toc}
          aria-label="文章目录"
          aria-hidden={inBody || undefined}
          inert={inBody || undefined}
          data-academic-toc=""
          data-collapsed={String(inBody)}
        >
          <p className={styles.tocHeading}>目录</p>
          <ol>
            {chapters.map((chapter, index) => (
              <li key={chapter.title}>
                <button
                  type="button"
                  onClick={() => jumpTo(index, true)}
                  aria-controls={chapterId(index)}
                >
                  <span aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {chapter.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div ref={body} className={styles.body} data-academic-body="">
          {chapters.map((chapter, index) => (
            <section
              key={chapter.title}
              id={chapterId(index)}
              ref={(node) => {
                chapterNodes.current[index] = node;
              }}
              className={styles.chapter}
              data-academic-chapter={index}
              aria-labelledby={`${chapterId(index)}-heading`}
            >
              <p
                className={styles.chapterNumber}
                aria-hidden="true"
                data-academic-section-number=""
              >
                {String(index + 1).padStart(2, "0")}
              </p>
              <h3 id={`${chapterId(index)}-heading`} tabIndex={-1}>
                {chapter.title}
              </h3>
              {chapter.paragraphs.map((paragraph, paragraphIndex) => (
                <div
                  key={`${paragraphIndex}-${paragraph.slice(0, 24)}`}
                  className={styles.paragraphGroup}
                >
                  <p>{paragraph}</p>
                  {(chapter.figures ?? [])
                    .filter(
                      (figure) => figure.afterParagraph === paragraphIndex,
                    )
                    .map((figure, figureIndex) => (
                      <figure
                        key={figure.src}
                        className={styles.figure}
                        data-academic-figure={`${index}-${figureIndex}`}
                      >
                        <img
                          src={figure.src}
                          alt={figure.alt}
                          loading="lazy"
                          decoding="async"
                        />
                        <figcaption>{figure.caption}</figcaption>
                      </figure>
                    ))}
                </div>
              ))}
            </section>
          ))}
        </div>
        <footer className={styles.citation} data-academic-citation="">
          <h3>引用信息</h3>
          <p>{special.citation[0]}</p>
          {special.citation[1] && (
            <p className={styles.sourceNote}>{special.citation[1]}</p>
          )}
        </footer>
      </article>
      {railPortalTarget
        ? createPortal(navigation, railPortalTarget)
        : navigation}
    </div>
  );
}
