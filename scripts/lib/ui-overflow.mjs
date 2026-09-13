export async function readExperienceOverflow(targetPage, mode) {
  return targetPage.evaluate((activeMode) => {
    const app = document.querySelector('.app')
    const main = document.querySelector('.main')
    const switcher = document.querySelector('[data-experience-mode-switcher]')
    const switcherRect = switcher?.getBoundingClientRect()
    const strategy = document.querySelector('[data-task-strategy]')
    const strategyRect = strategy?.getBoundingClientRect()
    const sidebarRect = document.querySelector('.sidebar')?.getBoundingClientRect()
    const videoView = document.querySelector('.video-studio-view')
    const videoViewRect = videoView?.getBoundingClientRect()
    const videoProjectPickerRect = document.querySelector('.video-studio-project-picker')?.getBoundingClientRect()
    const videoPanelRect = document.querySelector('.video-studio-panel')?.getBoundingClientRect()
    const projectTable = document.querySelector('[data-work-item-list]')
    const projectTableRect = projectTable?.getBoundingClientRect()
    const projectTableContent = projectTable?.querySelector('.pws-table-content')
    const projectTableVirtualScroll = projectTable?.querySelector('.pws-table-scroll')
    const surface = activeMode === 'assistant'
      ? document.querySelector('.experience-session:not([hidden])')
      : activeMode === 'studio'
        ? document.querySelector('.experience-workspace:not([hidden])')
        : document.querySelector('.experience-video:not([hidden])')
    const width = window.innerWidth
    const visibleOffenders = collectVisibleOffenders(width)
    return createSnapshot(activeMode, {
      app, main, surface, switcherRect, strategyRect, sidebarRect, videoView,
      videoViewRect, videoProjectPickerRect, videoPanelRect, projectTable,
      projectTableRect, projectTableContent, projectTableVirtualScroll, width, visibleOffenders
    })

    function createSnapshot(modeName, refs) {
      return {
        mode: modeName,
        width: refs.width,
        height: window.innerHeight,
        sidebarWidth: refs.sidebarRect ? Math.round(refs.sidebarRect.width) : -1,
        documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        appOverflow: refs.app ? Math.max(0, refs.app.scrollWidth - refs.app.clientWidth) : -1,
        mainOverflow: refs.main ? Math.max(0, refs.main.scrollWidth - refs.main.clientWidth) : -1,
        surfaceOverflow: refs.surface ? Math.max(0, refs.surface.scrollWidth - refs.surface.clientWidth) : -1,
        ...readViewportFlags(refs),
        ...readVideoMetrics(refs),
        projectTable: readProjectTable(refs),
        visibleOffenders: refs.visibleOffenders
      }
    }

    function readViewportFlags(refs) {
      return {
        switcherInsideViewport: Boolean(
          refs.switcherRect && refs.switcherRect.width > 0 && refs.switcherRect.height > 0 &&
          refs.switcherRect.left >= -1 && refs.switcherRect.right <= refs.width + 1
        ),
        strategyInsideViewport: Boolean(refs.strategyRect && refs.strategyRect.left >= -1 && refs.strategyRect.right <= refs.width + 1),
        strategyTextFits: [...document.querySelectorAll('[data-task-strategy-option]')]
          .every((button) => button.scrollWidth <= button.clientWidth + 1)
      }
    }

    function readVideoMetrics(refs) {
      return {
        videoHeaderClear: !refs.videoProjectPickerRect || !refs.videoPanelRect ||
          refs.videoProjectPickerRect.bottom <= refs.videoPanelRect.top + 1,
        videoViewOverflow: refs.videoView ? Math.max(0, refs.videoView.scrollWidth - refs.videoView.clientWidth) : -1,
        videoPanelInlineOverflow: !refs.videoViewRect || !refs.videoPanelRect
          ? -1
          : Math.max(0, refs.videoViewRect.left - refs.videoPanelRect.left, refs.videoPanelRect.right - refs.videoViewRect.right)
      }
    }

    function readProjectTable(refs) {
      if (!refs.projectTable) return null
      return {
        clientWidth: refs.projectTable.clientWidth,
        scrollWidth: refs.projectTable.scrollWidth,
        overflowX: getComputedStyle(refs.projectTable).overflowX,
        contentWidth: refs.projectTableContent?.getBoundingClientRect().width ?? -1,
        nestedHorizontalOverflow: refs.projectTableVirtualScroll
          ? Math.max(0, refs.projectTableVirtualScroll.scrollWidth - refs.projectTableVirtualScroll.clientWidth)
          : -1,
        insideViewport: Boolean(refs.projectTableRect && refs.projectTableRect.left >= -1 && refs.projectTableRect.right <= refs.width + 1)
      }
    }

    function collectVisibleOffenders(viewportWidth) {
      return Array.from(document.querySelectorAll('body *'))
        .flatMap((element) => visibleOffender(element, viewportWidth))
        .slice(0, 10)
    }

    function visibleOffender(element, viewportWidth) {
      if (hasHiddenAncestor(element)) return []
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0 || rect.right <= 0 || rect.left >= viewportWidth) return []
      if (rect.left >= -1 && rect.right <= viewportWidth + 1) return []
      if (hasScrollableAncestor(element)) return []
      return [{
        selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${Array.from(element.classList).join('.')}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right)
      }]
    }

    function hasHiddenAncestor(element) {
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true
      }
      return false
    }

    function hasScrollableAncestor(element) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const overflowX = getComputedStyle(ancestor).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return true
      }
      return false
    }
  }, mode)
}
