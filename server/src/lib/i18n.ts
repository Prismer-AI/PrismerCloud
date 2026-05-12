export const APP_LOCALES = ['zh', 'en', 'de', 'fr', 'es'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = 'en';

export const APP_LOCALE_STORAGE_KEY = 'prismer_locale';
export const APP_LOCALE_COOKIE = 'prismer_locale';

export const APP_LOCALE_LABELS: Record<AppLocale, { short: string; native: string; english: string }> = {
  zh: { short: '中', native: '中文', english: 'Chinese' },
  en: { short: 'EN', native: 'English', english: 'English' },
  de: { short: 'DE', native: 'Deutsch', english: 'German' },
  fr: { short: 'FR', native: 'Français', english: 'French' },
  es: { short: 'ES', native: 'Español', english: 'Spanish' },
};

type Primitive = string | number | boolean | null;
type MessageTree = { [key: string]: Primitive | MessageTree };

export type TranslationKey =
  | 'common.appName'
  | 'common.language'
  | 'common.refresh'
  | 'common.loading'
  | 'common.close'
  | 'common.open'
  | 'common.cancel'
  | 'common.edit'
  | 'common.save'
  | 'common.search'
  | 'common.notifications'
  | 'common.markAllRead'
  | 'common.noNotifications'
  | 'common.signedInAs'
  | 'common.user'
  | 'common.signIn'
  | 'common.signOut'
  | 'common.getApiKey'
  | 'common.github'
  | 'common.themeLight'
  | 'common.themeDark'
  | 'common.openMenu'
  | 'common.closeMenu'
  | 'nav.dashboard'
  | 'nav.workspace'
  | 'nav.playground'
  | 'nav.evolution'
  | 'nav.evolutionSpace'
  | 'nav.community'
  | 'nav.myCommunity'
  | 'nav.editProfile'
  | 'nav.docs'
  | 'nav.pricing'
  | 'workspace.personal'
  | 'workspace.stream.connecting'
  | 'workspace.stream.live'
  | 'workspace.stream.polling'
  | 'workspace.stream.offline'
  | 'workspace.leftRail.sessions'
  | 'workspace.leftRail.tasks'
  | 'workspace.leftRail.contacts'
  | 'workspace.leftRail.assets'
  | 'workspace.leftRail.library'
  | 'workspace.leftRail.devices'
  | 'workspace.leftRail.newSession'
  | 'workspace.leftRail.newAgent'
  | 'workspace.leftRail.today'
  | 'workspace.leftRail.inProgress'
  | 'workspace.leftRail.done'
  | 'workspace.leftRail.completion'
  | 'workspace.leftRail.open'
  | 'workspace.leftRail.working'
  | 'workspace.leftRail.noSessions'
  | 'workspace.taskBoard.title'
  | 'workspace.taskBoard.subtitle'
  | 'workspace.taskBoard.activity'
  | 'workspace.taskBoard.teamEfficiency'
  | 'workspace.taskBoard.tasksVelocity'
  | 'workspace.taskBoard.activeAgents'
  | 'workspace.taskBoard.editTask'
  | 'workspace.taskBoard.reassignTask'
  | 'workspace.taskBoard.addAttachment'
  | 'workspace.taskBoard.taskTitle'
  | 'workspace.taskBoard.taskDescription'
  | 'workspace.taskBoard.taskTitleRequired'
  | 'workspace.taskBoard.editFailed'
  | 'workspace.taskBoard.editSaved'
  | 'workspace.taskBoard.loadFailed'
  | 'workspace.taskBoard.assignBeforeTodo'
  | 'workspace.taskBoard.assignBeforeInProgress'
  | 'workspace.taskBoard.noAgentsAvailable'
  | 'workspace.taskBoard.emptyDrop'
  | 'workspace.taskBoard.addToColumn'
  | 'workspace.taskBoard.moveFailed'
  | 'workspace.taskBoard.movedSuccess'
  | 'workspace.taskBoard.moveKept'
  | 'workspace.taskBoard.moveHidden'
  | 'workspace.taskBoard.executionTitle'
  | 'workspace.taskBoard.executionDescription'
  | 'workspace.taskBoard.thisColumn'
  | 'workspace.taskBoard.executionInProgress'
  | 'workspace.taskBoard.executionBackToPending'
  | 'workspace.taskBoard.executionForce'
  | 'workspace.taskBoard.executionLongRunning'
  | 'workspace.taskBoard.executionSkipWarning'
  | 'workspace.taskBoard.changeStatus'
  | 'workspace.taskBoard.noActivityYet'
  | 'workspace.taskBoard.updatedToday'
  | 'workspace.taskBoard.currentStatus'
  | 'workspace.taskBoard.columns.backlog.label'
  | 'workspace.taskBoard.columns.backlog.hint'
  | 'workspace.taskBoard.columns.todo.label'
  | 'workspace.taskBoard.columns.todo.hint'
  | 'workspace.taskBoard.columns.inProgress.label'
  | 'workspace.taskBoard.columns.inProgress.hint'
  | 'workspace.taskBoard.columns.review.label'
  | 'workspace.taskBoard.columns.review.hint'
  | 'workspace.taskBoard.columns.done.label'
  | 'workspace.taskBoard.columns.done.hint'
  | 'workspace.session.chat'
  | 'workspace.session.details'
  | 'workspace.session.linkedTasks'
  | 'workspace.session.noLinkedContext'
  | 'workspace.session.direct'
  | 'workspace.session.group'
  | 'workspace.session.workspace'
  | 'workspace.session.noSessionSelected'
  | 'workspace.session.emptyHint'
  | 'workspace.session.lastActive'
  | 'workspace.session.members'
  | 'workspace.session.activeTasks'
  | 'workspace.session.completed'
  | 'workspace.session.searchMessages'
  | 'workspace.session.recentAssets'
  | 'workspace.session.recentCount'
  | 'workspace.session.addMember'
  | 'workspace.session.removeFromSession'
  | 'workspace.session.tasks'
  | 'workspace.session.recent'
  | 'workspace.session.noTasks'
  | 'workspace.session.searchingMessages'
  | 'workspace.session.searchMessagesInSession'
  | 'workspace.session.noMatchingMessages'
  | 'workspace.contacts.title'
  | 'workspace.contacts.subtitle'
  | 'workspace.runtime.title'
  | 'workspace.runtime.subtitle'
  | 'workspace.setup.title'
  | 'workspace.setup.agent'
  | 'workspace.setup.session'
  | 'workspace.setup.task'
  | 'workspace.setup.asset'
  | 'workspace.setup.createAgent'
  | 'workspace.setup.createSession'
  | 'workspace.setup.createTask'
  | 'workspace.setup.uploadAsset'
  | 'workspace.assets.title'
  | 'workspace.assets.subtitle'
  | 'workspace.assets.upload'
  | 'workspace.assets.search'
  | 'workspace.assets.empty'
  | 'workspace.assets.emptyHint'
  | 'workspace.assets.dropUpload';

type Messages = Record<AppLocale, MessageTree>;

const messages: Messages = {
  en: {
    common: {
      appName: 'Prismer Cloud',
      language: 'Language',
      refresh: 'Refresh',
      loading: 'Loading',
      close: 'Close',
      open: 'Open',
      cancel: 'Cancel',
      edit: 'Edit',
      save: 'Save',
      search: 'Search',
      notifications: 'Notifications',
      markAllRead: 'Mark all read',
      noNotifications: 'No notifications',
      signedInAs: 'Signed in as',
      user: 'User',
      signIn: 'Sign In',
      signOut: 'Sign Out',
      getApiKey: 'Get API Key',
      github: 'GitHub',
      themeLight: 'Switch to light mode',
      themeDark: 'Switch to dark mode',
      openMenu: 'Open menu',
      closeMenu: 'Close menu',
    },
    nav: {
      dashboard: 'Dashboard',
      workspace: 'Workspace',
      playground: 'Playground',
      evolution: 'Evolution',
      evolutionSpace: 'Evolution Space',
      community: 'Community',
      myCommunity: 'My Community',
      editProfile: 'Edit profile',
      docs: 'Docs',
      pricing: 'Pricing',
    },
    workspace: {
      personal: 'Personal Workspace',
      stream: { connecting: 'Connecting', live: 'Live', polling: 'Polling', offline: 'Offline' },
      leftRail: {
        sessions: 'Sessions',
        tasks: 'Tasks',
        contacts: 'Contacts',
        assets: 'Assets',
        library: 'Library',
        devices: 'Devices',
        newSession: 'New session',
        newAgent: 'New agent',
        today: "Today's overview",
        inProgress: 'In progress',
        done: 'Done',
        completion: 'Completion',
        open: 'Open',
        working: 'Working',
        noSessions: 'No sessions yet. Start one with an agent or a group.',
      },
      taskBoard: {
        title: 'Task Kanban',
        subtitle: '{count} {count, plural, one {task} other {tasks}} · drag between columns to update status',
        activity: 'Activity feed',
        teamEfficiency: 'Team efficiency',
        tasksVelocity: 'Tasks velocity',
        activeAgents: 'Active agents',
        editTask: 'Edit task',
        reassignTask: 'Reassign…',
        addAttachment: 'Add attachment',
        taskTitle: 'Title',
        taskDescription: 'Description',
        taskTitleRequired: 'Task title is required.',
        editFailed: 'Edit failed: {message}',
        editSaved: 'Task saved.',
        loadFailed: 'Failed to load tasks',
        assignBeforeTodo: 'Assign the task to an agent before moving it to Todo.',
        assignBeforeInProgress: 'Assign the task to an agent before moving it to In Progress.',
        noAgentsAvailable: 'No agents available to assign.',
        emptyDrop: 'Drop a task here',
        addToColumn: 'Add a task to {column}',
        moveFailed: 'Couldn’t move task: {message}',
        movedSuccess: 'Moved "{title}" to {column}.',
        moveKept: 'Move requested, but server kept "{title}" in {column}.',
        moveHidden: 'Move requested, but "{title}" is no longer visible on this board.',
        executionTitle: 'Change execution status?',
        executionDescription: 'Moving this task to {column} changes its execution state, not just its visual column.',
        thisColumn: 'this column',
        executionInProgress:
          'The task will be marked running and dispatched to the assigned agent daemon. If the daemon is offline, the cloud records it for redispatch on the next heartbeat.',
        executionBackToPending:
          'If the task is currently running, the cloud will send a cancel signal before moving it back to pending. {column} also changes the assignee behavior.',
        executionForce:
          'If the task is currently running, the cloud will send a cancel signal before forcing the new state.',
        executionLongRunning:
          'This assignee is a long-running agent, so the cloud status becomes authoritative immediately while the hosted service may finish cleanup asynchronously.',
        executionSkipWarning: 'Do not show this warning again',
        changeStatus: 'Change status',
        noActivityYet: 'No task activity yet',
        updatedToday: 'updated today',
        currentStatus: 'Current status',
        columns: {
          backlog: { label: 'Backlog', hint: 'pending · unassigned' },
          todo: { label: 'Todo', hint: 'pending · assigned' },
          inProgress: { label: 'In Progress', hint: 'assigned · running' },
          review: { label: 'In Review', hint: 'awaiting approval' },
          done: { label: 'Done', hint: 'completed' },
        },
      },
      session: {
        chat: 'Chat',
        details: 'Details',
        linkedTasks: 'Linked tasks',
        noLinkedContext: 'No linked context yet',
        direct: 'Direct',
        group: 'Group',
        workspace: 'Workspace session',
        noSessionSelected: 'No session selected',
        emptyHint:
          'Open a session to coordinate humans, long-running agents, and CLI agents around the active task board.',
        lastActive: 'Last active {time}',
        members: 'Members',
        activeTasks: 'Active tasks',
        completed: 'Completed',
        searchMessages: 'Search messages',
        recentAssets: 'Recent assets',
        recentCount: '{count} recent',
        addMember: 'Add member',
        removeFromSession: 'Remove from session',
        tasks: 'Tasks',
        recent: 'Recent',
        noTasks: 'No tasks',
        searchingMessages: 'Searching messages...',
        searchMessagesInSession: 'Search messages in this session',
        noMatchingMessages: 'No matching messages',
      },
      contacts: { title: 'Friends and invites', subtitle: 'Contacts' },
      runtime: {
        title: 'Devices',
        subtitle: 'Each device owns one daemon/runtime surface and the agents running on it.',
      },
      setup: {
        title: 'Workspace setup',
        agent: 'Create or activate an agent',
        session: 'Create a session',
        task: 'Add a task',
        asset: 'Upload an asset',
        createAgent: 'New agent',
        createSession: 'New session',
        createTask: 'New task',
        uploadAsset: 'Upload',
      },
      assets: {
        title: 'Assets',
        subtitle: '{count} assets · workspace files, outputs, and uploaded references',
        upload: 'Upload',
        search: 'Search assets',
        empty: 'No assets',
        emptyHint:
          'Upload files or let agents produce task outputs. They will appear here as reusable workspace assets.',
        dropUpload: 'Drop files to upload',
      },
    },
  },
  zh: {
    common: {
      appName: 'Prismer Cloud',
      language: '语言',
      refresh: '刷新',
      loading: '加载中',
      close: '关闭',
      open: '打开',
      cancel: '取消',
      edit: '编辑',
      save: '保存',
      search: '搜索',
      notifications: '通知',
      markAllRead: '全部标为已读',
      noNotifications: '暂无通知',
      signedInAs: '当前登录',
      user: '用户',
      signIn: '登录',
      signOut: '退出登录',
      getApiKey: '获取 API Key',
      github: 'GitHub',
      themeLight: '切换到浅色模式',
      themeDark: '切换到深色模式',
      openMenu: '打开菜单',
      closeMenu: '关闭菜单',
    },
    nav: {
      dashboard: '仪表盘',
      workspace: '工作区',
      playground: '试验场',
      evolution: '进化',
      evolutionSpace: '进化空间',
      community: '社区',
      myCommunity: '我的社区',
      editProfile: '编辑资料',
      docs: '文档',
      pricing: '价格',
    },
    workspace: {
      personal: '个人工作区',
      stream: { connecting: '连接中', live: '实时', polling: '轮询', offline: '离线' },
      leftRail: {
        sessions: '会话',
        tasks: '任务',
        contacts: '联系人',
        assets: '资产',
        library: '资料库',
        devices: '设备',
        newSession: '新建会话',
        newAgent: '新建 Agent',
        today: '今日概览',
        inProgress: '进行中',
        done: '已完成',
        completion: '完成率',
        open: '待处理',
        working: '处理中',
        noSessions: '暂无会话。可以从 Agent 或群组开始。',
      },
      taskBoard: {
        title: '任务看板',
        subtitle: '{count} 个任务 · 拖拽卡片更新状态',
        activity: '活动动态',
        teamEfficiency: '团队效率',
        tasksVelocity: '任务流速',
        activeAgents: '活跃 Agent',
        editTask: '编辑任务',
        reassignTask: '重新分配…',
        addAttachment: '添加附件',
        taskTitle: '标题',
        taskDescription: '描述',
        taskTitleRequired: '任务标题不能为空。',
        editFailed: '编辑失败：{message}',
        editSaved: '任务已保存。',
        loadFailed: '任务加载失败',
        assignBeforeTodo: '在将任务移到 Todo 前，请先分配给一个 Agent。',
        assignBeforeInProgress: '在将任务移到 In Progress 前，请先分配给一个 Agent。',
        noAgentsAvailable: '当前没有可分配的 Agent。',
        emptyDrop: '把任务拖到这里',
        addToColumn: '向 {column} 添加任务',
        moveFailed: '移动任务失败：{message}',
        movedSuccess: '已将 "{title}" 移到 {column}。',
        moveKept: '已请求移动，但服务端仍将 "{title}" 保留在 {column}。',
        moveHidden: '已请求移动，但 "{title}" 已不在当前看板中可见。',
        executionTitle: '切换执行状态？',
        executionDescription: '将任务移动到 {column} 会改变执行状态，而不仅是视觉列。',
        thisColumn: '当前列',
        executionInProgress:
          '任务将被标记为运行中并派发给已分配的 Agent daemon。若 daemon 离线，云端会在下一次心跳时重新派发。',
        executionBackToPending: '如果任务当前正在运行，云端会先发送取消信号再移回待处理。{column} 还会影响分配人行为。',
        executionForce: '如果任务当前正在运行，云端会先发送取消信号再强制更新为新状态。',
        executionLongRunning: '该分配对象是长运行 Agent，因此云端状态会立即成为权威，而宿主服务可能稍后完成清理。',
        executionSkipWarning: '不再显示此警告',
        changeStatus: '更改状态',
        noActivityYet: '暂无任务活动',
        updatedToday: '今日更新',
        currentStatus: '当前状态',
        columns: {
          backlog: { label: 'Backlog', hint: '待处理 · 未分配' },
          todo: { label: 'Todo', hint: '待处理 · 已分配' },
          inProgress: { label: '进行中', hint: '已分配 · 运行中' },
          review: { label: '审核中', hint: '等待批准' },
          done: { label: '已完成', hint: '完成' },
        },
      },
      session: {
        chat: '聊天',
        details: '详情',
        linkedTasks: '关联任务',
        noLinkedContext: '暂无关联上下文',
        direct: '单聊',
        group: '群组',
        workspace: '工作区会话',
        noSessionSelected: '未选择会话',
        emptyHint: '打开一个会话，围绕当前任务看板协作人类、长期运行的 Agent 和 CLI Agent。',
        lastActive: '最后活跃 {time}',
        members: '成员',
        activeTasks: '活跃任务',
        completed: '已完成',
        searchMessages: '搜索消息',
        recentAssets: '最近资产',
        recentCount: '最近 {count} 个',
        addMember: '添加成员',
        removeFromSession: '从会话移除',
        tasks: '任务',
        recent: '最近',
        noTasks: '暂无任务',
        searchingMessages: '正在搜索消息...',
        searchMessagesInSession: '搜索当前会话消息',
        noMatchingMessages: '没有匹配消息',
      },
      contacts: { title: '好友与邀请', subtitle: '联系人' },
      runtime: {
        title: '设备',
        subtitle: '每台设备承载一个 daemon/runtime 入口，以及运行在其上的 Agent。',
      },
      setup: {
        title: '工作区设置',
        agent: '创建或激活 Agent',
        session: '创建会话',
        task: '添加任务',
        asset: '上传资产',
        createAgent: '新建 Agent',
        createSession: '新建会话',
        createTask: '新建任务',
        uploadAsset: '上传',
      },
      assets: {
        title: '资产',
        subtitle: '{count} 个资产 · 工作区文件、输出和上传引用',
        upload: '上传',
        search: '搜索资产',
        empty: '暂无资产',
        emptyHint: '上传文件，或让 Agent 产出任务结果。它们会作为可复用工作区资产显示在这里。',
        dropUpload: '拖放文件以上传',
      },
    },
  },
  de: {
    common: {
      appName: 'Prismer Cloud',
      language: 'Sprache',
      refresh: 'Aktualisieren',
      loading: 'Lädt',
      close: 'Schließen',
      open: 'Öffnen',
      cancel: 'Abbrechen',
      edit: 'Bearbeiten',
      save: 'Speichern',
      search: 'Suchen',
      notifications: 'Benachrichtigungen',
      markAllRead: 'Alle als gelesen markieren',
      noNotifications: 'Keine Benachrichtigungen',
      signedInAs: 'Angemeldet als',
      user: 'Benutzer',
      signIn: 'Anmelden',
      signOut: 'Abmelden',
      getApiKey: 'API-Key erhalten',
      github: 'GitHub',
      themeLight: 'Zum hellen Modus wechseln',
      themeDark: 'Zum dunklen Modus wechseln',
      openMenu: 'Menü öffnen',
      closeMenu: 'Menü schließen',
    },
    nav: {
      dashboard: 'Dashboard',
      workspace: 'Arbeitsbereich',
      playground: 'Testfeld',
      evolution: 'Evolution',
      evolutionSpace: 'Evolutionsraum',
      community: 'Community',
      myCommunity: 'Meine Community',
      docs: 'Dokumente',
      pricing: 'Preise',
    },
    workspace: {
      personal: 'Persönlicher Arbeitsbereich',
      stream: { connecting: 'Verbinden', live: 'Live', polling: 'Abfrage', offline: 'Offline' },
      leftRail: {
        sessions: 'Sitzungen',
        tasks: 'Aufgaben',
        contacts: 'Kontakte',
        assets: 'Assets',
        library: 'Bibliothek',
        devices: 'Geräte',
        newSession: 'Neue Sitzung',
        newAgent: 'Neuer Agent',
        today: 'Heutige Übersicht',
        inProgress: 'In Arbeit',
        done: 'Erledigt',
        completion: 'Abschluss',
        open: 'Offen',
        working: 'Aktiv',
        noSessions: 'Noch keine Sitzungen. Starte mit einem Agenten oder einer Gruppe.',
      },
      taskBoard: {
        title: 'Aufgaben-Kanban',
        subtitle: '{count} Aufgaben · zwischen Spalten ziehen, um den Status zu ändern',
        activity: 'Aktivitätsfeed',
        teamEfficiency: 'Team-Effizienz',
        tasksVelocity: 'Aufgaben-Durchsatz',
        activeAgents: 'Aktive Agenten',
        editTask: 'Aufgabe bearbeiten',
        reassignTask: 'Neu zuweisen…',
        addAttachment: 'Anhang hinzufügen',
        taskTitle: 'Titel',
        taskDescription: 'Beschreibung',
        taskTitleRequired: 'Ein Aufgabentitel ist erforderlich.',
        editFailed: 'Bearbeiten fehlgeschlagen: {message}',
        editSaved: 'Aufgabe gespeichert.',
        loadFailed: 'Aufgaben konnten nicht geladen werden',
        assignBeforeTodo: 'Weise die Aufgabe einem Agenten zu, bevor du sie nach Todo verschiebst.',
        assignBeforeInProgress: 'Weise die Aufgabe einem Agenten zu, bevor du sie nach In Progress verschiebst.',
        noAgentsAvailable: 'Keine Agenten zum Zuweisen verfügbar.',
        emptyDrop: 'Aufgabe hier ablegen',
        addToColumn: 'Aufgabe zu {column} hinzufügen',
        moveFailed: 'Aufgabe konnte nicht verschoben werden: {message}',
        movedSuccess: '"{title}" nach {column} verschoben.',
        moveKept: 'Verschiebung angefordert, aber der Server hat "{title}" in {column} gelassen.',
        moveHidden: 'Verschiebung angefordert, aber "{title}" ist auf diesem Board nicht mehr sichtbar.',
        executionTitle: 'Ausführungsstatus ändern?',
        executionDescription:
          'Das Verschieben nach {column} ändert den Ausführungsstatus, nicht nur die sichtbare Spalte.',
        thisColumn: 'diese Spalte',
        executionInProgress:
          'Die Aufgabe wird als laufend markiert und an den zugewiesenen Agenten-Daemon gesendet. Ist der Daemon offline, merkt sich die Cloud die erneute Zustellung für den nächsten Heartbeat.',
        executionBackToPending:
          'Wenn die Aufgabe gerade läuft, sendet die Cloud zuerst ein Abbruchsignal, bevor sie wieder auf ausstehend gesetzt wird. {column} ändert außerdem das Zuweisungsverhalten.',
        executionForce:
          'Wenn die Aufgabe gerade läuft, sendet die Cloud zuerst ein Abbruchsignal, bevor der neue Status erzwungen wird.',
        executionLongRunning:
          'Dieser Zuweisungspunkt ist ein langfristig laufender Agent, daher ist der Cloud-Status sofort maßgeblich, während der gehostete Dienst die Bereinigung später abschließen kann.',
        executionSkipWarning: 'Diese Warnung nicht mehr anzeigen',
        changeStatus: 'Status ändern',
        noActivityYet: 'Noch keine Aufgabenaktivität',
        updatedToday: 'heute aktualisiert',
        currentStatus: 'Aktueller Status',
        columns: {
          backlog: { label: 'Backlog', hint: 'ausstehend · nicht zugewiesen' },
          todo: { label: 'Todo', hint: 'ausstehend · zugewiesen' },
          inProgress: { label: 'In Arbeit', hint: 'zugewiesen · laufend' },
          review: { label: 'In Prüfung', hint: 'wartet auf Freigabe' },
          done: { label: 'Erledigt', hint: 'abgeschlossen' },
        },
      },
      session: {
        chat: 'Chat',
        details: 'Details',
        linkedTasks: 'Verknüpfte Aufgaben',
        noLinkedContext: 'Noch kein verknüpfter Kontext',
        direct: 'Direkt',
        group: 'Gruppe',
        workspace: 'Arbeitsbereichssitzung',
        noSessionSelected: 'Keine Sitzung ausgewählt',
        emptyHint:
          'Öffne eine Sitzung, um Menschen, langfristig laufende Agenten und CLI-Agenten am aktiven Aufgabenboard zu koordinieren.',
        lastActive: 'Zuletzt aktiv {time}',
        members: 'Mitglieder',
        activeTasks: 'Aktive Aufgaben',
        completed: 'Abgeschlossen',
        searchMessages: 'Nachrichten suchen',
        recentAssets: 'Neueste Assets',
        recentCount: '{count} aktuell',
        addMember: 'Mitglied hinzufügen',
        removeFromSession: 'Aus Sitzung entfernen',
        tasks: 'Aufgaben',
        recent: 'Aktuell',
        noTasks: 'Keine Aufgaben',
        searchingMessages: 'Nachrichten werden gesucht...',
        searchMessagesInSession: 'Nachrichten in dieser Sitzung suchen',
        noMatchingMessages: 'Keine passenden Nachrichten',
      },
      contacts: { title: 'Freunde und Einladungen', subtitle: 'Kontakte' },
      runtime: {
        title: 'Geräte',
        subtitle: 'Jedes Gerät besitzt eine Daemon-/Runtime-Fläche und die darauf laufenden Agenten.',
      },
      setup: {
        title: 'Arbeitsbereich einrichten',
        agent: 'Agent erstellen oder aktivieren',
        session: 'Sitzung erstellen',
        task: 'Aufgabe hinzufügen',
        asset: 'Asset hochladen',
        createAgent: 'Neuer Agent',
        createSession: 'Neue Sitzung',
        createTask: 'Neue Aufgabe',
        uploadAsset: 'Hochladen',
      },
      assets: {
        title: 'Assets',
        subtitle: '{count} Assets · Arbeitsbereichsdateien, Ausgaben und hochgeladene Referenzen',
        upload: 'Hochladen',
        search: 'Assets suchen',
        empty: 'Keine Assets',
        emptyHint:
          'Lade Dateien hoch oder lasse Agenten Aufgabenergebnisse erzeugen. Sie erscheinen hier als wiederverwendbare Arbeitsbereichs-Assets.',
        dropUpload: 'Dateien zum Hochladen ablegen',
      },
    },
  },
  fr: {
    common: {
      appName: 'Prismer Cloud',
      language: 'Langue',
      refresh: 'Actualiser',
      loading: 'Chargement',
      close: 'Fermer',
      open: 'Ouvrir',
      cancel: 'Annuler',
      edit: 'Modifier',
      save: 'Enregistrer',
      search: 'Rechercher',
      notifications: 'Notifications',
      markAllRead: 'Tout marquer comme lu',
      noNotifications: 'Aucune notification',
      signedInAs: 'Connecté en tant que',
      user: 'Utilisateur',
      signIn: 'Se connecter',
      signOut: 'Se déconnecter',
      getApiKey: 'Obtenir une clé API',
      github: 'GitHub',
      themeLight: 'Passer au mode clair',
      themeDark: 'Passer au mode sombre',
      openMenu: 'Ouvrir le menu',
      closeMenu: 'Fermer le menu',
    },
    nav: {
      dashboard: 'Tableau de bord',
      workspace: 'Espace de travail',
      playground: "Terrain d'essai",
      evolution: 'Évolution',
      evolutionSpace: "Espace d'évolution",
      community: 'Communauté',
      myCommunity: 'Ma communauté',
      docs: 'Docs',
      pricing: 'Tarifs',
    },
    workspace: {
      personal: 'Espace personnel',
      stream: { connecting: 'Connexion', live: 'En direct', polling: 'Interrogation', offline: 'Hors ligne' },
      leftRail: {
        sessions: 'Sessions',
        tasks: 'Tâches',
        contacts: 'Contacts',
        assets: 'Ressources',
        library: 'Bibliothèque',
        devices: 'Appareils',
        newSession: 'Nouvelle session',
        newAgent: 'Nouvel agent',
        today: "Vue d'aujourd'hui",
        inProgress: 'En cours',
        done: 'Terminé',
        completion: 'Achèvement',
        open: 'Ouvert',
        working: 'Actif',
        noSessions: 'Aucune session. Commencez avec un agent ou un groupe.',
      },
      taskBoard: {
        title: 'Kanban des tâches',
        subtitle: '{count} tâches · faites glisser entre les colonnes pour mettre à jour le statut',
        activity: "Fil d'activité",
        teamEfficiency: "Efficacité de l'équipe",
        tasksVelocity: 'Vélocité des tâches',
        activeAgents: 'Agents actifs',
        editTask: 'Modifier la tâche',
        reassignTask: 'Réaffecter…',
        addAttachment: 'Ajouter une pièce jointe',
        taskTitle: 'Titre',
        taskDescription: 'Description',
        taskTitleRequired: 'Le titre de la tâche est requis.',
        editFailed: 'Échec de la modification : {message}',
        editSaved: 'Tâche enregistrée.',
        loadFailed: 'Échec du chargement des tâches',
        assignBeforeTodo: 'Affectez la tâche à un agent avant de la déplacer vers Todo.',
        assignBeforeInProgress: 'Affectez la tâche à un agent avant de la déplacer vers In Progress.',
        noAgentsAvailable: 'Aucun agent disponible à affecter.',
        emptyDrop: 'Déposez une tâche ici',
        addToColumn: 'Ajouter une tâche à {column}',
        moveFailed: 'Déplacement impossible : {message}',
        movedSuccess: '"{title}" déplacée vers {column}.',
        moveKept: 'Déplacement demandé, mais le serveur a conservé "{title}" dans {column}.',
        moveHidden: 'Déplacement demandé, mais "{title}" n’est plus visible sur ce tableau.',
        executionTitle: 'Changer l’état d’exécution ?',
        executionDescription:
          'Déplacer cette tâche vers {column} change son état d’exécution, pas seulement sa colonne visuelle.',
        thisColumn: 'cette colonne',
        executionInProgress:
          'La tâche sera marquée en cours d’exécution et envoyée au démon de l’agent assigné. Si le démon est hors ligne, le cloud planifie une nouvelle distribution au prochain battement.',
        executionBackToPending:
          'Si la tâche est en cours, le cloud enverra d’abord un signal d’annulation avant de la remettre en attente. {column} modifie aussi le comportement d’affectation.',
        executionForce:
          'Si la tâche est en cours, le cloud enverra d’abord un signal d’annulation avant d’imposer le nouvel état.',
        executionLongRunning:
          'Cet assigné est un agent longue durée, donc l’état cloud devient immédiatement autoritaire pendant que le service hébergé termine éventuellement le nettoyage.',
        executionSkipWarning: 'Ne plus afficher cet avertissement',
        changeStatus: 'Changer le statut',
        noActivityYet: 'Aucune activité de tâche pour le moment',
        updatedToday: 'mis à jour aujourd’hui',
        currentStatus: 'Statut actuel',
        columns: {
          backlog: { label: 'Backlog', hint: 'en attente · non affecté' },
          todo: { label: 'Todo', hint: 'en attente · affecté' },
          inProgress: { label: 'En cours', hint: 'affecté · en cours' },
          review: { label: 'En revue', hint: 'en attente d’approbation' },
          done: { label: 'Terminé', hint: 'terminé' },
        },
      },
      session: {
        chat: 'Chat',
        details: 'Détails',
        linkedTasks: 'Tâches liées',
        noLinkedContext: 'Aucun contexte lié',
        direct: 'Direct',
        group: 'Groupe',
        workspace: 'Session de travail',
        noSessionSelected: 'Aucune session sélectionnée',
        emptyHint:
          'Ouvrez une session pour coordonner humains, agents longue durée et agents CLI autour du tableau de tâches actif.',
        lastActive: 'Dernière activité {time}',
        members: 'Membres',
        activeTasks: 'Tâches actives',
        completed: 'Terminé',
        searchMessages: 'Rechercher des messages',
        recentAssets: 'Ressources récentes',
        recentCount: '{count} récents',
        addMember: 'Ajouter un membre',
        removeFromSession: 'Retirer de la session',
        tasks: 'Tâches',
        recent: 'Récent',
        noTasks: 'Aucune tâche',
        searchingMessages: 'Recherche de messages...',
        searchMessagesInSession: 'Rechercher dans cette session',
        noMatchingMessages: 'Aucun message correspondant',
      },
      contacts: { title: 'Amis et invitations', subtitle: 'Contacts' },
      runtime: {
        title: 'Appareils',
        subtitle: 'Chaque appareil possède une surface daemon/runtime et les agents qui y tournent.',
      },
      setup: {
        title: "Configuration de l'espace",
        agent: 'Créer ou activer un agent',
        session: 'Créer une session',
        task: 'Ajouter une tâche',
        asset: 'Téléverser une ressource',
        createAgent: 'Nouvel agent',
        createSession: 'Nouvelle session',
        createTask: 'Nouvelle tâche',
        uploadAsset: 'Téléverser',
      },
      assets: {
        title: 'Ressources',
        subtitle: '{count} ressources · fichiers, sorties et références téléversées',
        upload: 'Téléverser',
        search: 'Rechercher des ressources',
        empty: 'Aucune ressource',
        emptyHint:
          'Téléversez des fichiers ou laissez les agents produire des résultats de tâche. Ils apparaîtront ici comme ressources réutilisables.',
        dropUpload: 'Déposez les fichiers pour téléverser',
      },
    },
  },
  es: {
    common: {
      appName: 'Prismer Cloud',
      language: 'Idioma',
      refresh: 'Actualizar',
      loading: 'Cargando',
      close: 'Cerrar',
      open: 'Abrir',
      cancel: 'Cancelar',
      edit: 'Editar',
      save: 'Guardar',
      search: 'Buscar',
      notifications: 'Notificaciones',
      markAllRead: 'Marcar todo como leído',
      noNotifications: 'Sin notificaciones',
      signedInAs: 'Sesión iniciada como',
      user: 'Usuario',
      signIn: 'Iniciar sesión',
      signOut: 'Cerrar sesión',
      getApiKey: 'Obtener API Key',
      github: 'GitHub',
      themeLight: 'Cambiar a modo claro',
      themeDark: 'Cambiar a modo oscuro',
      openMenu: 'Abrir menú',
      closeMenu: 'Cerrar menú',
    },
    nav: {
      dashboard: 'Panel',
      workspace: 'Espacio de trabajo',
      playground: 'Campo de pruebas',
      evolution: 'Evolución',
      evolutionSpace: 'Espacio de evolución',
      community: 'Comunidad',
      myCommunity: 'Mi comunidad',
      docs: 'Docs',
      pricing: 'Precios',
    },
    workspace: {
      personal: 'Espacio personal',
      stream: { connecting: 'Conectando', live: 'En vivo', polling: 'Sondeando', offline: 'Sin conexión' },
      leftRail: {
        sessions: 'Sesiones',
        tasks: 'Tareas',
        contacts: 'Contactos',
        assets: 'Recursos',
        library: 'Biblioteca',
        devices: 'Dispositivos',
        newSession: 'Nueva sesión',
        newAgent: 'Nuevo agente',
        today: 'Resumen de hoy',
        inProgress: 'En progreso',
        done: 'Hecho',
        completion: 'Finalización',
        open: 'Abierto',
        working: 'Activo',
        noSessions: 'Aún no hay sesiones. Empieza con un agente o un grupo.',
      },
      taskBoard: {
        title: 'Kanban de tareas',
        subtitle: '{count} tareas · arrastra entre columnas para actualizar el estado',
        activity: 'Actividad',
        teamEfficiency: 'Eficiencia del equipo',
        tasksVelocity: 'Velocidad de tareas',
        activeAgents: 'Agentes activos',
        editTask: 'Editar tarea',
        reassignTask: 'Reasignar…',
        addAttachment: 'Agregar adjunto',
        taskTitle: 'Título',
        taskDescription: 'Descripción',
        taskTitleRequired: 'Se requiere un título de tarea.',
        editFailed: 'La edición falló: {message}',
        editSaved: 'Tarea guardada.',
        loadFailed: 'No se pudieron cargar las tareas',
        assignBeforeTodo: 'Asigna la tarea a un agente antes de moverla a Todo.',
        assignBeforeInProgress: 'Asigna la tarea a un agente antes de moverla a In Progress.',
        noAgentsAvailable: 'No hay agentes disponibles para asignar.',
        emptyDrop: 'Suelta una tarea aquí',
        addToColumn: 'Agregar una tarea a {column}',
        moveFailed: 'No se pudo mover la tarea: {message}',
        movedSuccess: 'Se movió "{title}" a {column}.',
        moveKept: 'Se solicitó el movimiento, pero el servidor mantuvo "{title}" en {column}.',
        moveHidden: 'Se solicitó el movimiento, pero "{title}" ya no es visible en este tablero.',
        executionTitle: '¿Cambiar el estado de ejecución?',
        executionDescription: 'Mover esta tarea a {column} cambia su estado de ejecución, no solo su columna visual.',
        thisColumn: 'esta columna',
        executionInProgress:
          'La tarea se marcará como en ejecución y se enviará al daemon del agente asignado. Si el daemon está desconectado, la nube programará un reenvío en el siguiente latido.',
        executionBackToPending:
          'Si la tarea está en ejecución, la nube enviará primero una señal de cancelación antes de devolverla a pendiente. {column} también cambia el comportamiento de asignación.',
        executionForce:
          'Si la tarea está en ejecución, la nube enviará primero una señal de cancelación antes de forzar el nuevo estado.',
        executionLongRunning:
          'Este asignado es un agente de larga duración, así que el estado en la nube se vuelve autoritativo de inmediato mientras el servicio alojado termina la limpieza después.',
        executionSkipWarning: 'No mostrar esta advertencia de nuevo',
        changeStatus: 'Cambiar estado',
        noActivityYet: 'Todavía no hay actividad de tareas',
        updatedToday: 'actualizado hoy',
        currentStatus: 'Estado actual',
        columns: {
          backlog: { label: 'Backlog', hint: 'pendiente · sin asignar' },
          todo: { label: 'Todo', hint: 'pendiente · asignado' },
          inProgress: { label: 'En progreso', hint: 'asignado · en ejecución' },
          review: { label: 'En revisión', hint: 'esperando aprobación' },
          done: { label: 'Hecho', hint: 'completado' },
        },
      },
      session: {
        chat: 'Chat',
        details: 'Detalles',
        linkedTasks: 'Tareas vinculadas',
        noLinkedContext: 'Aún no hay contexto vinculado',
        direct: 'Directo',
        group: 'Grupo',
        workspace: 'Sesión de trabajo',
        noSessionSelected: 'No hay sesión seleccionada',
        emptyHint:
          'Abre una sesión para coordinar personas, agentes de larga ejecución y agentes CLI alrededor del tablero de tareas activo.',
        lastActive: 'Última actividad {time}',
        members: 'Miembros',
        activeTasks: 'Tareas activas',
        completed: 'Completado',
        searchMessages: 'Buscar mensajes',
        recentAssets: 'Recursos recientes',
        recentCount: '{count} recientes',
        addMember: 'Agregar miembro',
        removeFromSession: 'Quitar de la sesión',
        tasks: 'Tareas',
        recent: 'Reciente',
        noTasks: 'Sin tareas',
        searchingMessages: 'Buscando mensajes...',
        searchMessagesInSession: 'Buscar mensajes en esta sesión',
        noMatchingMessages: 'No hay mensajes coincidentes',
      },
      contacts: { title: 'Amigos e invitaciones', subtitle: 'Contactos' },
      runtime: {
        title: 'Dispositivos',
        subtitle: 'Cada dispositivo tiene una superficie daemon/runtime y los agentes que se ejecutan allí.',
      },
      setup: {
        title: 'Configurar espacio',
        agent: 'Crear o activar un agente',
        session: 'Crear una sesión',
        task: 'Agregar una tarea',
        asset: 'Subir un recurso',
        createAgent: 'Nuevo agente',
        createSession: 'Nueva sesión',
        createTask: 'Nueva tarea',
        uploadAsset: 'Subir',
      },
      assets: {
        title: 'Recursos',
        subtitle: '{count} recursos · archivos, salidas y referencias subidas',
        upload: 'Subir',
        search: 'Buscar recursos',
        empty: 'Sin recursos',
        emptyHint:
          'Sube archivos o deja que los agentes produzcan resultados de tareas. Aparecerán aquí como recursos reutilizables.',
        dropUpload: 'Suelta archivos para subir',
      },
    },
  },
};

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return Boolean(value && APP_LOCALES.includes(value as AppLocale));
}

export function getAppMessages(locale: AppLocale): MessageTree {
  return messages[locale] ?? messages[DEFAULT_APP_LOCALE];
}

export function translate(locale: AppLocale, key: TranslationKey, values?: Record<string, string | number>): string {
  const value = readPath(getAppMessages(locale), key) ?? readPath(getAppMessages(DEFAULT_APP_LOCALE), key) ?? key;
  const text = typeof value === 'string' ? value : key;
  return interpolate(text, values);
}

function readPath(tree: MessageTree, path: string): Primitive | MessageTree | undefined {
  return path.split('.').reduce<Primitive | MessageTree | undefined>((node, part) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    return node[part];
  }, tree);
}

function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(
    /\{(\w+)(?:,\s*plural,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\})?\}/g,
    (_match, key, one, other) => {
      const value = values[key];
      if (one !== undefined && other !== undefined) {
        return Number(value) === 1
          ? String(one).replace('#', String(value))
          : String(other).replace('#', String(value));
      }
      return value == null ? '' : String(value);
    },
  );
}
