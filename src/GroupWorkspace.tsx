import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiOutlined,
  AppstoreOutlined,
  ArrowLeftOutlined,
  BellOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  GitlabOutlined,
  HistoryOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SettingOutlined
} from "@ant-design/icons";
import {
  Alert,
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal,
  Popconfirm,
  Result,
  Row,
  Select,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  type MenuProps
} from "antd";
import type {
  CreateReviewProjectInput,
  CreateManualReviewInput,
  GitBranchSummary,
  GitCommitPage,
  GitCommitSummary,
  GitRepositoryStatus,
  GroupNodeConfig,
  GroupNodeConfigUpdate,
  GroupWorkspaceData,
  ManualReviewPreview,
  ProjectGroupSummary,
  ReviewProject,
  ReviewTask,
  UpdateReviewProjectInput
} from "../shared/contracts";
import { managerApi } from "./api";

const { Header, Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;
export type WorkspacePage = "dashboard" | "projects" | "reviews" | "settings";
type SettingsSection = "general" | "gitlab" | "ai" | "feishu";
type ReviewView = "all" | "queued" | "completed" | "findings";

export function GroupWorkspace({
  group,
  page,
  projectId,
  reviewTaskId,
  onBack,
  onPageChange,
  onProjectOpen,
  onProjectClose
}: {
  group: ProjectGroupSummary;
  page: WorkspacePage;
  projectId?: string;
  reviewTaskId?: string;
  onBack: () => void;
  onPageChange: (page: WorkspacePage) => void;
  onProjectOpen: (projectId: string, reviewTaskId?: string) => void;
  onProjectClose: () => void;
}) {
  const [workspace, setWorkspace] = useState<GroupWorkspaceData>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [reviewView, setReviewView] = useState<ReviewView>("all");
  const { message } = AntApp.useApp();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setWorkspace(await managerApi.workspace(group.id));
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "项目组节点不可用");
    } finally {
      setLoading(false);
    }
  }, [group.id]);

  useEffect(() => {
    void load();
  }, [load, page]);

  const saveConfig = async (input: GroupNodeConfigUpdate) => {
    setSaving(true);
    try {
      const config = await managerApi.updateGroupConfig(group.id, input);
      setWorkspace((current) => current ? { ...current, config } : current);
      message.success("项目组配置已保存到节点本地");
    } catch (caught) {
      message.error(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const menuItems: MenuProps["items"] = [
    { key: "dashboard", icon: <DashboardOutlined />, label: "仪表盘" },
    { key: "projects", icon: <AppstoreOutlined />, label: "项目管理" },
    { key: "reviews", icon: <FileSearchOutlined />, label: "Review 任务" },
    { type: "divider" },
    { key: "settings", icon: <SettingOutlined />, label: "项目组设置" }
  ];

  const online = group.node?.status === "online" && !error;

  return (
    <Layout className="workspace-shell">
      <Sider width={238} breakpoint="lg" collapsedWidth={72} className="workspace-sider">
        <button className="workspace-brand" onClick={onBack} type="button">
          <Avatar shape="square" className="group-avatar">{group.name.slice(0, 1)}</Avatar>
          <span>
            <strong>{group.name}</strong>
            <small>{group.key}</small>
          </span>
        </button>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          items={menuItems}
          onClick={({ key }) => {
            if (key === "reviews") setReviewView("all");
            onPageChange(key as WorkspacePage);
          }}
        />
        <div className="workspace-node-state">
          <Badge status={online ? "success" : "error"} />
          <span>{online ? "项目组节点在线" : "项目组节点离线"}</span>
        </div>
      </Sider>

      <Layout>
        <Header className="workspace-header">
          <Space size={14}>
            <Tooltip title="返回总管理端">
              <Button icon={<ArrowLeftOutlined />} onClick={onBack} />
            </Tooltip>
            <div>
              <Text className="eyebrow">项目组工作台</Text>
              <Title level={4}>{workspace?.config.general.displayName ?? group.name}</Title>
            </div>
          </Space>
          <Space>
            <Tag color={online ? "success" : "error"}>{online ? "节点在线" : "节点离线"}</Tag>
            {group.node ? <Text code>{group.node.host}:{group.node.port}</Text> : null}
          </Space>
        </Header>

        <Content className="workspace-content">
          {loading ? <Skeleton active paragraph={{ rows: 10 }} /> : null}
          {!loading && error ? (
            <Result
              status="warning"
              title="项目组节点暂时不可用"
              subTitle="项目组页面的数据与配置保存在独立 Node 节点中，请先启动该节点。"
              extra={<Space><Button onClick={onBack}>返回项目组列表</Button><Button type="primary" onClick={() => void load()}>重试</Button></Space>}
            />
          ) : null}
          {!loading && workspace && page === "dashboard" ? (
            <Dashboard
              data={workspace}
              onOpenProjects={() => onPageChange("projects")}
              onOpenReviews={(view) => {
                setReviewView(view);
                onPageChange("reviews");
              }}
              onOpenSettings={(section) => {
                setSettingsSection(section);
                onPageChange("settings");
              }}
            />
          ) : null}
          {!loading && workspace && page === "projects" ? (
            projectId
              ? <ProjectDetailPage groupId={group.id} projectId={projectId} focusTaskId={reviewTaskId} onBack={onProjectClose} />
              : <ProjectsPage groupId={group.id} onProjectOpen={onProjectOpen} />
          ) : null}
          {!loading && workspace && page === "reviews" ? (
            <ReviewsPage groupId={group.id} view={reviewView} onViewChange={setReviewView} onProjectOpen={onProjectOpen} />
          ) : null}
          {!loading && workspace && page === "settings" ? (
            <SettingsPage
              config={workspace.config}
              saving={saving}
              activeSection={settingsSection}
              onSectionChange={setSettingsSection}
              onSave={saveConfig}
            />
          ) : null}
        </Content>
      </Layout>
    </Layout>
  );
}

function Dashboard({
  data,
  onOpenProjects,
  onOpenReviews,
  onOpenSettings
}: {
  data: GroupWorkspaceData;
  onOpenProjects: () => void;
  onOpenReviews: (view: ReviewView) => void;
  onOpenSettings: (section: SettingsSection) => void;
}) {
  const { config, stats, runtime } = data;
  const setupItems = [
    { label: "项目组节点已连接", done: runtime.status === "online" },
    { label: "本地仓库目录已设置", done: Boolean(config.repository.rootPath) },
    { label: "GitLab 连接已配置", done: config.gitlab.tokenConfigured && Boolean(config.gitlab.baseUrl) },
    {
      label: "DeepSeek Review 已配置",
      done: Boolean(config.ai.apiKeyConfigured && config.ai.model && config.ai.reviewPrompt)
    },
    { label: "至少创建一个 Review 项目", done: stats.projectCount > 0 }
  ];

  return (
    <>
      <section className="page-heading workspace-heading">
        <div>
          <Title level={2}>仪表盘</Title>
          <Paragraph type="secondary">只展示当前项目组的连接、项目与 Review 运行状态。</Paragraph>
        </div>
        <Tag color="blue">配置版本 v{config.revision}</Tag>
      </section>

      <Row gutter={[16, 16]} className="metric-row">
        <Metric title="项目" value={stats.projectCount} icon={<AppstoreOutlined />} tone="blue" onClick={onOpenProjects} />
        <Metric title="排队任务" value={stats.queuedReviewCount} icon={<ClockCircleOutlined />} tone="amber" onClick={() => onOpenReviews("queued")} />
        <Metric title="完成 Review" value={stats.completedReviewCount} icon={<FileSearchOutlined />} tone="green" onClick={() => onOpenReviews("completed")} />
        <Metric title="发现问题" value={stats.findingCount} icon={<SafetyCertificateOutlined />} tone="purple" onClick={() => onOpenReviews("findings")} />
      </Row>

      <Row gutter={[18, 18]} className="workspace-grid">
        <Col xs={24} xl={15}>
          <Card
            title="集成与运行环境"
            extra={<Button type="link" onClick={() => onOpenSettings("general")}>管理配置</Button>}
            bordered={false}
            className="content-card"
          >
            <Row gutter={[14, 14]}>
              <IntegrationCard
                icon={<CloudServerOutlined />}
                title="GitLab"
                description={config.gitlab.baseUrl || "尚未配置 GitLab 地址"}
                configured={config.gitlab.tokenConfigured && Boolean(config.gitlab.baseUrl)}
                onClick={() => onOpenSettings("gitlab")}
              />
              <IntegrationCard
                icon={<RobotOutlined />}
                title="AI 模型"
                description={config.ai.model || "尚未选择 DeepSeek 模型"}
                configured={config.ai.apiKeyConfigured && Boolean(config.ai.model && config.ai.baseUrl)}
                onClick={() => onOpenSettings("ai")}
              />
              <IntegrationCard
                icon={<BellOutlined />}
                title="飞书通知"
                description={config.feishu.enabled ? config.feishu.name || "已启用" : "通知已关闭"}
                configured={config.feishu.enabled && config.feishu.webhookConfigured}
                disabled={!config.feishu.enabled}
                onClick={() => onOpenSettings("feishu")}
              />
              <IntegrationCard
                icon={<FolderOpenOutlined />}
                title="本地仓库"
                description={config.repository.rootPath}
                configured={Boolean(config.repository.rootPath)}
                onClick={() => onOpenSettings("general")}
              />
            </Row>
          </Card>

          <Card
            title="最近 Review"
            extra={<Button type="link" onClick={() => onOpenReviews("all")}>查看全部</Button>}
            bordered={false}
            className="content-card workspace-section-card"
          >
            {data.recentReviews.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 Review 记录" />
            ) : (
              <div className="recent-review-list">
                {data.recentReviews.map((review) => (
                  <button type="button" key={review.id} className="recent-review-item" onClick={() => onOpenReviews("all")}>
                    <Flex justify="space-between" align="center" gap={16}>
                      <div>
                        <Text strong>{review.projectName}</Text>
                        <div><Text type="secondary">{review.mergeRequest}</Text></div>
                      </div>
                      <Space size={8}>
                        <Tag color={reviewStatusMeta[review.status as ReviewTask["status"]]?.color ?? "default"}>
                          {reviewStatusMeta[review.status as ReviewTask["status"]]?.label ?? review.status}
                        </Tag>
                        <RightOutlined className="dashboard-link-arrow" />
                      </Space>
                    </Flex>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="启用清单" bordered={false} className="content-card onboarding-card">
            <div className="setup-list">
              {setupItems.map((item, index) => (
                <div className={`setup-item ${item.done ? "done" : ""}`} key={item.label}>
                  <span className="setup-index">{item.done ? <CheckCircleFilled /> : index + 1}</span>
                  <Text>{item.label}</Text>
                </div>
              ))}
            </div>
          </Card>
          <Card title="节点信息" bordered={false} className="content-card workspace-section-card">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="实例 ID"><Text code>{runtime.instanceId.slice(0, 12)}…</Text></Descriptions.Item>
              <Descriptions.Item label="节点端口">{runtime.port}</Descriptions.Item>
              <Descriptions.Item label="启动时间">{new Date(runtime.startedAt).toLocaleString("zh-CN")}</Descriptions.Item>
              <Descriptions.Item label="配置更新时间">{new Date(config.updatedAt).toLocaleString("zh-CN")}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
    </>
  );
}

function Metric({
  title,
  value,
  icon,
  tone,
  onClick
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  tone: "blue" | "amber" | "green" | "purple";
  onClick: () => void;
}) {
  return (
    <Col xs={12} lg={6}>
      <button type="button" className="metric-card-action" onClick={onClick} aria-label={`查看${title}`}>
        <Card bordered={false} className="metric-card">
          <span className={`metric-icon ${tone}`}>{icon}</span>
          <Statistic title={title} value={value} />
          <RightOutlined className="dashboard-link-arrow" />
        </Card>
      </button>
    </Col>
  );
}

function IntegrationCard({
  icon,
  title,
  description,
  configured,
  disabled = false,
  onClick
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  configured: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Col xs={24} md={12}>
      <button type="button" className="integration-card" onClick={onClick} aria-label={`打开${title}配置`}>
        <span className="integration-icon">{icon}</span>
        <div className="integration-copy">
          <Flex justify="space-between" align="center">
            <Text strong>{title}</Text>
            <Tag color={disabled ? "default" : configured ? "success" : "warning"}>
              {disabled ? "已关闭" : configured ? "已配置" : "待配置"}
            </Tag>
          </Flex>
          <Text type="secondary" ellipsis={{ tooltip: description }}>{description}</Text>
        </div>
        <RightOutlined className="dashboard-link-arrow" />
      </button>
    </Col>
  );
}

function ProjectsPage({ groupId, onProjectOpen }: { groupId: string; onProjectOpen: (projectId: string) => void }) {
  const [projects, setProjects] = useState<ReviewProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewProject>();
  const [webhookInfo, setWebhookInfo] = useState<{ project: ReviewProject; secret?: string }>();
  const [form] = Form.useForm();
  const { message, modal } = AntApp.useApp();

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await managerApi.projects(groupId));
      setLoadError(undefined);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "项目加载失败");
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const openCreate = () => {
    setEditing(undefined);
    form.resetFields();
    form.setFieldsValue({ enabled: true, defaultBranch: "main" });
    setEditorOpen(true);
  };

  const openEdit = (project: ReviewProject) => {
    setEditing(project);
    form.resetFields();
    form.setFieldsValue(project);
    setEditorOpen(true);
  };

  const saveProject = async () => {
    const values = await form.validateFields() as CreateReviewProjectInput;
    setSaving(true);
    try {
      if (editing) {
        const { key: _immutableKey, ...input } = values;
        await managerApi.updateProject(groupId, editing.id, input as UpdateReviewProjectInput);
        message.success("项目配置已保存");
      } else {
        const credentials = await managerApi.createProject(groupId, values);
        setWebhookInfo(credentials);
        message.success("项目已创建，请将 Webhook 配置到 GitLab");
      }
      setEditorOpen(false);
      form.resetFields();
      await loadProjects();
    } catch (caught) {
      message.error(caught instanceof Error ? caught.message : "项目保存失败");
    } finally {
      setSaving(false);
    }
  };

  const deleteProject = async (project: ReviewProject) => {
    try {
      await managerApi.deleteProject(groupId, project.id);
      message.success("项目配置已删除，本地仓库目录未删除");
      await loadProjects();
    } catch (caught) {
      message.error(caught instanceof Error ? caught.message : "删除失败");
    }
  };

  const rotateSecret = (project: ReviewProject) => {
    modal.confirm({
      title: "轮换 Webhook Secret？",
      content: "旧 Secret 会立即失效。轮换后必须同步修改 GitLab Webhook 配置。",
      okText: "确认轮换",
      cancelText: "取消",
      async onOk() {
        const credentials = await managerApi.rotateProjectWebhook(groupId, project.id);
        setWebhookInfo(credentials);
        await loadProjects();
        message.success("已生成新的 Webhook Secret");
      }
    });
  };

  return (
    <>
      <section className="page-heading workspace-heading">
        <div>
          <Title level={2}>项目管理</Title>
          <Paragraph type="secondary">每个项目对应一个 GitLab Merge Request Webhook，并共享项目组的串行 Review 队列。</Paragraph>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void loadProjects()} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={Boolean(loadError)}>新建项目</Button>
        </Space>
      </section>
      {loadError ? (
        <Alert
          type="warning"
          showIcon
          message="项目功能暂时不可用"
          description={loadError}
          action={<Button size="small" onClick={() => void loadProjects()}>重新连接</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Card bordered={false} className="content-card">
        <Table<ReviewProject>
          rowKey="id"
          loading={loading}
          dataSource={projects}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目" /> }}
          scroll={{ x: 1080 }}
          columns={[
            {
              title: "项目",
              key: "project",
              fixed: "left",
              width: 190,
              render: (_value, project) => (
                <div>
                  <Button type="link" className="project-name-link" onClick={() => onProjectOpen(project.id)}>{project.name}</Button>
                  <div><Text type="secondary">{project.key}</Text></div>
                </div>
              )
            },
            {
              title: "GitLab Project",
              dataIndex: "gitlabProjectRef",
              width: 190,
              render: (value: string) => <Text code>{value}</Text>
            },
            {
              title: "默认分支",
              dataIndex: "defaultBranch",
              width: 120,
              render: (value: string) => <Tag>{value}</Tag>
            },
            {
              title: "本地仓库",
              dataIndex: "localRepositoryPath",
              ellipsis: true,
              render: (value: string) => <Tooltip title={value}><Text type="secondary">{value}</Text></Tooltip>
            },
            {
              title: "Webhook",
              key: "webhook",
              width: 150,
              render: (_value, project) => (
                <Space direction="vertical" size={2}>
                  <Tag color={project.webhook.state === "active" ? "success" : "warning"}>
                    {project.webhook.state === "active" ? "已收到事件" : "等待配置"}
                  </Tag>
                  {project.webhook.lastEventAt ? <Text type="secondary">{new Date(project.webhook.lastEventAt).toLocaleString("zh-CN")}</Text> : null}
                </Space>
              )
            },
            {
              title: "状态",
              dataIndex: "enabled",
              width: 90,
              render: (enabled: boolean) => <Tag color={enabled ? "success" : "default"}>{enabled ? "启用" : "停用"}</Tag>
            },
            {
              title: "操作",
              key: "actions",
              fixed: "right",
              width: 365,
              render: (_value, project) => (
                <Space size={4}>
                  <Button size="small" onClick={() => onProjectOpen(project.id)}>Commit / Review</Button>
                  <Button size="small" icon={<LinkOutlined />} onClick={() => setWebhookInfo({ project })}>Webhook</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(project)}>编辑</Button>
                  <Popconfirm
                    title="删除这个项目配置？"
                    description="排队任务会取消，但不会删除磁盘上的本地仓库。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void deleteProject(project)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              )
            }
          ]}
        />
      </Card>

      <Modal
        title={editing ? "编辑项目" : "新建 Review 项目"}
        open={editorOpen}
        width={680}
        okText={editing ? "保存" : "创建并生成 Webhook"}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void saveProject()}
        onCancel={() => { setEditorOpen(false); form.resetFields(); }}
        destroyOnHidden
        forceRender
      >
        <Alert
          type="info"
          showIcon
          message="GitLab Project 可填写数字 ID 或 namespace/project 路径"
          description="项目创建后会生成唯一的 Webhook URL 和 Secret，项目组节点不会保存 Secret 明文。"
          style={{ marginBottom: 18 }}
        />
        <Form form={form} layout="vertical" requiredMark="optional">
          <Row gutter={16}>
            <Col xs={24} md={14}><Form.Item name="name" label="项目名称" rules={[{ required: true, min: 2 }]}><Input placeholder="G004 Client" autoFocus /></Form.Item></Col>
            <Col xs={24} md={10}>
              <Form.Item name="key" label="项目标识" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/, message: "只能使用字母、数字、连字符和下划线" }]}>
                <Input placeholder="g004-client" disabled={Boolean(editing)} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="项目说明"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="gitlabProjectRef" label="GitLab Project ID / Path" rules={[{ required: true }]} extra="例如：128 或 g004/g004_client">
            <Input placeholder="g004/g004_client" />
          </Form.Item>
          <Form.Item name="repositoryUrl" label="Git 仓库地址" rules={[{ required: true }]} extra="支持 HTTPS 或 SSH Clone 地址">
            <Input placeholder="https://gitlab.example.com/g004/g004_client.git" />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={16}><Form.Item name="defaultBranch" label="默认目标分支" rules={[{ required: true }]}><Input placeholder="main" /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="enabled" label="启用 Review" valuePropName="checked"><Switch /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={`GitLab Webhook · ${webhookInfo?.project.name ?? ""}`}
        open={Boolean(webhookInfo)}
        width={760}
        cancelText="关闭"
        okText="完成"
        onOk={() => setWebhookInfo(undefined)}
        onCancel={() => setWebhookInfo(undefined)}
      >
        {webhookInfo ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              type={webhookInfo.secret ? "warning" : "info"}
              showIcon
              message={webhookInfo.secret ? "Secret 只在这里显示一次" : "Secret 明文不会保存在节点中"}
              description={webhookInfo.secret ? "关闭窗口前请将 URL 和 Secret 配置到 GitLab。" : "如果 Secret 已丢失，请轮换后重新配置 GitLab Webhook。"}
            />
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="URL"><Text copyable code>{webhookInfo.project.webhook.url}</Text></Descriptions.Item>
              <Descriptions.Item label="Secret token">
                {webhookInfo.secret ? <Text copyable code>{webhookInfo.secret}</Text> : <Text type="secondary">不可再次查看</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Trigger"><Tag color="blue">Merge request events</Tag></Descriptions.Item>
              <Descriptions.Item label="当前状态">
                <Tag color={webhookInfo.project.webhook.state === "active" ? "success" : "warning"}>
                  {webhookInfo.project.webhook.state === "active" ? "已收到有效事件" : "等待 GitLab 请求"}
                </Tag>
              </Descriptions.Item>
            </Descriptions>
            <Alert
              type="success"
              showIcon
              message="GitLab 配置步骤"
              description="进入项目 Settings → Webhooks，填写 URL 和 Secret token，只勾选 Merge request events，然后保存并发送测试请求。"
            />
            <Flex justify="flex-end">
              <Button danger icon={<ReloadOutlined />} onClick={() => rotateSecret(webhookInfo.project)}>轮换 Secret</Button>
            </Flex>
          </Space>
        ) : null}
      </Modal>
    </>
  );
}

function ProjectDetailPage({
  groupId,
  projectId,
  focusTaskId,
  onBack
}: {
  groupId: string;
  projectId: string;
  focusTaskId?: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<ReviewProject>();
  const [repositoryStatus, setRepositoryStatus] = useState<GitRepositoryStatus>();
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [commitPage, setCommitPage] = useState<GitCommitPage>({ items: [], page: 1, pageSize: 50, hasMore: false });
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [commitLoading, setCommitLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [branchFilter, setBranchFilter] = useState<string>();
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selectedShas, setSelectedShas] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState<"commits" | "branch">("commits");
  const [sourceBranch, setSourceBranch] = useState<string>();
  const [preview, setPreview] = useState<ManualReviewPreview>();
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultTask, setResultTask] = useState<ReviewTask>();
  const [manualPanelTab, setManualPanelTab] = useState<"create" | "history">(focusTaskId ? "history" : "create");
  const handledFocusTask = useRef<string | undefined>(undefined);
  const { message } = AntApp.useApp();

  const loadProject = useCallback(async () => {
    setLoading(true);
    try {
      const [projectResult, statusResult, taskResult] = await Promise.all([
        managerApi.project(groupId, projectId),
        managerApi.repositoryStatus(groupId, projectId),
        managerApi.reviews(groupId)
      ]);
      setProject(projectResult);
      setRepositoryStatus(statusResult);
      setTasks(taskResult);
      if (statusResult.valid) {
        const branchResult = await managerApi.repositoryBranches(groupId, projectId);
        setBranches(branchResult);
        setSourceBranch((current) => current ?? branchResult.find((branch) => branch.name !== projectResult.defaultBranch)?.name ?? branchResult[0]?.name);
      } else {
        setBranches([]);
      }
      setLoadError(undefined);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "项目详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [groupId, projectId]);

  const loadCommits = useCallback(async () => {
    if (!repositoryStatus?.valid) return;
    setCommitLoading(true);
    try {
      setCommitPage(await managerApi.repositoryCommits(groupId, projectId, {
        branch: branchFilter,
        search,
        since,
        until,
        page,
        pageSize
      }));
    } catch (caught) {
      message.error(caught instanceof Error ? caught.message : "Commit 历史加载失败");
    } finally {
      setCommitLoading(false);
    }
  }, [branchFilter, groupId, message, page, pageSize, projectId, repositoryStatus?.valid, search, since, until]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    void loadCommits();
  }, [loadCommits]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void managerApi.reviews(groupId).then(setTasks).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [groupId]);

  useEffect(() => {
    if (!focusTaskId || handledFocusTask.current === focusTaskId) return;
    const task = tasks.find((item) => item.id === focusTaskId && item.projectId === projectId && item.triggerType === "manual");
    if (!task) return;
    handledFocusTask.current = focusTaskId;
    setManualPanelTab("history");
    window.requestAnimationFrame(() => {
      document.getElementById("manual-review-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (task.result) setResultTask(task);
  }, [focusTaskId, projectId, tasks]);

  const resetSelectionPreview = () => setPreview(undefined);
  const manualInput = (): CreateManualReviewInput => ({
    selection: selectionMode === "branch"
      ? {
          mode: "branch",
          branch: sourceBranch,
          targetBranch: project?.defaultBranch || "main",
          commitShas: []
        }
      : {
          mode: "commits",
          commitShas: selectedShas,
          targetBranch: project?.defaultBranch || "main"
        }
  });

  const previewReview = async () => {
    if (selectionMode === "commits" && selectedShas.length === 0) {
      message.warning("请至少选择一个 Commit");
      return;
    }
    if (selectionMode === "branch" && !sourceBranch) {
      message.warning("请选择源分支");
      return;
    }
    setPreviewing(true);
    try {
      setPreview(await managerApi.previewManualReview(groupId, projectId, manualInput()));
    } catch (caught) {
      message.error(caught instanceof Error ? caught.message : "Review 范围预览失败");
    } finally {
      setPreviewing(false);
    }
  };

  const submitReview = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      const task = await managerApi.createManualReview(groupId, projectId, {
        selection: preview.selection
      });
      setTasks((current) => [task, ...current]);
      setPreview(undefined);
      setSelectedShas([]);
      setManualPanelTab("history");
      message.success("手动 Code Review 已进入项目组串行队列");
    } catch (caught) {
      message.error(caught instanceof Error ? caught.message : "手动 Review 提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Skeleton active paragraph={{ rows: 12 }} />;
  if (loadError || !project || !repositoryStatus) {
    return <Result status="warning" title="项目详情暂时不可用" subTitle={loadError} extra={<Space><Button onClick={onBack}>返回项目列表</Button><Button type="primary" onClick={() => void loadProject()}>重试</Button></Space>} />;
  }

  const manualTasks = tasks.filter((task) => task.projectId === projectId && task.triggerType === "manual");
  const repositoryReady = repositoryStatus.valid && !repositoryStatus.locked;
  const statusAlertType = !repositoryReady ? "warning" : repositoryStatus.remoteMatches ? "success" : "warning";

  return (
    <>
      <section className="page-heading workspace-heading project-detail-heading">
        <Space size={14} align="start">
          <Button icon={<ArrowLeftOutlined />} onClick={onBack} />
          <div>
            <Space wrap>
              <Title level={2}>{project.name}</Title>
              <Tag color={project.enabled ? "success" : "default"}>{project.enabled ? "Review 已启用" : "Review 已停用"}</Tag>
            </Space>
            <Paragraph type="secondary">{project.description || project.gitlabProjectRef}</Paragraph>
          </div>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void loadProject()}>刷新仓库</Button>
      </section>

      <Card bordered={false} className="content-card repository-overview-card">
        <Alert
          showIcon
          type={statusAlertType}
          message={repositoryReady ? (repositoryStatus.remoteMatches ? "本地仓库可用于手动 Review" : "仓库可用，但 Origin 与项目配置不一致") : "本地仓库尚未就绪"}
          description={!repositoryReady
            ? `可以把同一仓库的完整目录（必须包含 .git）复制到 ${project.localRepositoryPath}，完成后点击“刷新仓库”进行校验。${repositoryStatus.error ? ` 当前状态：${repositoryStatus.error}` : ""}`
            : repositoryStatus.remoteMatches
              ? "Commit 查询只读取本地 Git 数据；真正执行 Review 前仍会在串行队列中 Fetch 并校验范围。"
              : `当前 Origin：${repositoryStatus.originUrl || "未配置"}；项目配置：${project.repositoryUrl}`}
          style={{ marginBottom: 18 }}
        />
        <Descriptions size="small" column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="本地路径"><Text copyable code>{project.localRepositoryPath}</Text></Descriptions.Item>
          <Descriptions.Item label="当前分支">{repositoryStatus.currentBranch ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="HEAD"><Text code>{repositoryStatus.headSha?.slice(0, 12) ?? "—"}</Text></Descriptions.Item>
          <Descriptions.Item label="工作区">{repositoryStatus.clean ? <Tag color="success">干净</Tag> : <Tag color="warning">有未提交修改</Tag>}</Descriptions.Item>
        </Descriptions>
      </Card>

      {repositoryReady ? (
        <Row gutter={[18, 18]} className="project-review-grid">
          <Col xs={24} xl={16}>
            <Card
              bordered={false}
              className="content-card"
              title={<Space><HistoryOutlined />Commit 树</Space>}
              extra={<Text type="secondary">已选择 {selectedShas.length} 个 Commit</Text>}
            >
              <div className="commit-filters">
                <Select
                  allowClear
                  showSearch
                  placeholder="全部分支"
                  value={branchFilter}
                  onChange={(value) => { setBranchFilter(value); setPage(1); setSelectedShas([]); resetSelectionPreview(); }}
                  options={branches.map((branch) => ({ value: branch.name, label: branch.name }))}
                  style={{ minWidth: 190 }}
                />
                <Input.Search
                  allowClear
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  onSearch={(value) => { setSearch(value.trim()); setPage(1); }}
                  placeholder="提交信息关键词"
                  style={{ minWidth: 220, flex: 1 }}
                />
                <Input type="date" value={since} onChange={(event) => { setSince(event.target.value); setPage(1); }} aria-label="开始日期" />
                <Input type="date" value={until} onChange={(event) => { setUntil(event.target.value); setPage(1); }} aria-label="结束日期" />
              </div>
              <Table<GitCommitSummary>
                rowKey="sha"
                loading={commitLoading}
                dataSource={commitPage.items}
                rowSelection={{
                  selectedRowKeys: selectedShas,
                  preserveSelectedRowKeys: true,
                  onChange: (keys) => { setSelectedShas(keys.map(String)); setSelectionMode("commits"); resetSelectionPreview(); }
                }}
                pagination={{
                  current: page,
                  pageSize,
                  total: commitPage.hasMore ? page * pageSize + 1 : (page - 1) * pageSize + commitPage.items.length,
                  showSizeChanger: true,
                  pageSizeOptions: [20, 50, 100],
                  onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }
                }}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的 Commit" /> }}
                columns={[
                  {
                    title: "Commit",
                    key: "commit",
                    render: (_value, commit) => (
                      <div className="commit-tree-cell">
                        <span className="commit-tree-rail"><i /></span>
                        <div className="commit-main-copy">
                          <Flex gap={8} align="center" wrap>
                            <Text strong>{commit.subject}</Text>
                            {commit.refs.slice(0, 3).map((ref) => <Tag key={ref} color="blue">{ref}</Tag>)}
                          </Flex>
                          <Space size={8} wrap>
                            <Text code>{commit.shortSha}</Text>
                            <Text type="secondary">{commit.authorName}</Text>
                            <Text type="secondary">{new Date(commit.authoredAt).toLocaleString("zh-CN")}</Text>
                          </Space>
                        </div>
                      </div>
                    )
                  }
                ]}
              />
            </Card>
          </Col>

          <Col xs={24} xl={8}>
            <Card id="manual-review-panel" bordered={false} className="content-card manual-review-card" title={<Space><GitlabOutlined />手动 Code Review</Space>}>
              <Tabs
                activeKey={manualPanelTab}
                onChange={(key) => setManualPanelTab(key as "create" | "history")}
                items={[
                  {
                    key: "create",
                    label: "发起 Review",
                    children: (
                      <Space direction="vertical" size={16} style={{ width: "100%" }}>
                        <div>
                          <Text strong>选择方式</Text>
                          <Select
                            value={selectionMode}
                            onChange={(value) => { setSelectionMode(value); resetSelectionPreview(); }}
                            style={{ width: "100%", marginTop: 8 }}
                            options={[
                              { value: "commits", label: `已选 Commit（${selectedShas.length}）` },
                              { value: "branch", label: "快速选择整个分支" }
                            ]}
                          />
                        </div>
                        {selectionMode === "branch" ? (
                          <div>
                            <Text strong>源分支</Text>
                            <Select
                              showSearch
                              value={sourceBranch}
                              onChange={(value) => { setSourceBranch(value); resetSelectionPreview(); }}
                              options={branches.map((branch) => ({ value: branch.name, label: branch.name }))}
                              style={{ width: "100%", marginTop: 8 }}
                            />
                          </div>
                        ) : (
                          <Alert type={selectedShas.length ? "info" : "warning"} showIcon message={selectedShas.length ? `将审查 ${selectedShas.length} 个指定 Commit` : "请从左侧 Commit 树选择提交"} />
                        )}
                        <Button block onClick={() => void previewReview()} loading={previewing}>预览 Review 范围</Button>
                        {preview ? (
                          <div className="manual-preview">
                            <Text strong>范围预览</Text>
                            <Descriptions column={1} size="small">
                              <Descriptions.Item label="Commit">{preview.commitCount}</Descriptions.Item>
                              <Descriptions.Item label="文件">{preview.fileCount}</Descriptions.Item>
                              <Descriptions.Item label="代码行"><Text type="success">+{preview.additions}</Text> / <Text type="danger">-{preview.deletions}</Text></Descriptions.Item>
                            </Descriptions>
                          </div>
                        ) : null}
                        <Button type="primary" block disabled={!preview} loading={submitting} onClick={() => void submitReview()}>
                          提交到串行 Review 队列
                        </Button>
                      </Space>
                    )
                  },
                  {
                    key: "history",
                    label: `Review 历史（${manualTasks.length}）`,
                    children: (
                      <List<ReviewTask>
                        className="manual-review-list"
                        dataSource={manualTasks}
                        pagination={manualTasks.length > 5 ? { pageSize: 5, size: "small" } : false}
                        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无手动 Review" /> }}
                        renderItem={(task) => (
                          <List.Item
                            className="manual-history-item"
                            actions={task.result
                              ? [<Button key="result" type="link" size="small" onClick={() => setResultTask(task)}>查看结果</Button>]
                              : task.error
                                ? [<Tooltip key="error" title={task.error}><Text type="danger">查看错误</Text></Tooltip>]
                                : []}
                          >
                            <List.Item.Meta
                              title={<Text strong ellipsis={{ tooltip: task.mergeRequestTitle }}>{task.mergeRequestTitle}</Text>}
                              description={(
                                <Space size={[6, 6]} wrap>
                                  <Tag color={reviewStatusMeta[task.status].color}>{reviewStatusMeta[task.status].label}</Tag>
                                  <Text type="secondary">{task.result ? `${task.result.findings.length} 个问题` : "等待结果"}</Text>
                                  <Text type="secondary">{new Date(task.createdAt).toLocaleString("zh-CN")}</Text>
                                </Space>
                              )}
                            />
                          </List.Item>
                        )}
                      />
                    )
                  }
                ]}
              />
            </Card>
          </Col>
        </Row>
      ) : null}

      <ReviewResultModal task={resultTask} onClose={() => setResultTask(undefined)} />
    </>
  );
}

function ReviewResultModal({ task, onClose }: { task?: ReviewTask; onClose: () => void }) {
  return (
    <Modal
      title={`手动 Review 结果 · ${task?.projectName ?? ""}`}
      open={Boolean(task)}
      width={920}
      footer={<Button type="primary" onClick={onClose}>关闭</Button>}
      onCancel={onClose}
    >
      {task?.result ? (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type={task.result.findings.length ? "warning" : "success"}
            showIcon
            message={task.result.summary}
            description={`结论：${task.result.verdict} · 风险：${task.result.riskLevel} · ${task.result.findings.length} 个问题`}
          />
          <Table
            rowKey={(finding) => `${finding.file}:${finding.line}:${finding.title}`}
            dataSource={task.result.findings}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有发现需要处理的问题" /> }}
            columns={[
              { title: "级别", dataIndex: "severity", width: 95, render: (value: string) => <Tag color={value === "critical" ? "red" : value === "high" ? "orange" : value === "medium" ? "gold" : "blue"}>{value}</Tag> },
              { title: "位置", width: 220, render: (_value, finding) => <Text code>{finding.file}{finding.line ? `:${finding.line}` : ""}</Text> },
              { title: "问题", render: (_value, finding) => <div><Text strong>{finding.title}</Text><div><Text type="secondary">{finding.description}</Text></div><div className="finding-suggestion">建议：{finding.suggestion}</div></div> }
            ]}
          />
        </Space>
      ) : null}
    </Modal>
  );
}

const reviewStatusMeta: Record<ReviewTask["status"], { label: string; color: string }> = {
  queued: { label: "排队中", color: "processing" },
  running: { label: "Review 中", color: "blue" },
  completed: { label: "已完成", color: "success" },
  failed: { label: "失败", color: "error" },
  cancelled: { label: "已取消", color: "default" },
  superseded: { label: "已被新版本替代", color: "warning" }
};

function ReviewsPage({
  groupId,
  view,
  onViewChange,
  onProjectOpen
}: {
  groupId: string;
  view: ReviewView;
  onViewChange: (view: ReviewView) => void;
  onProjectOpen: (projectId: string, reviewTaskId?: string) => void;
}) {
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [resultTask, setResultTask] = useState<ReviewTask>();
  const { message } = AntApp.useApp();

  const loadTasks = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setTasks(await managerApi.reviews(groupId));
      setLoadError(undefined);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Review 任务加载失败");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => void loadTasks(true), 3000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  const retryTask = async (task: ReviewTask) => {
    try {
      await managerApi.retryReview(groupId, task.id);
      message.success("Review 任务已重新排队");
      await loadTasks();
    } catch (caught) {
      message.error(caught instanceof Error ? caught.message : "任务重试失败");
    }
  };

  const visibleTasks = tasks.filter((task) => {
    if (view === "queued") return task.status === "queued";
    if (view === "completed") return task.status === "completed";
    if (view === "findings") return (task.result?.findings.length ?? 0) > 0;
    return true;
  });

  return (
    <>
      <section className="page-heading workspace-heading">
        <div>
          <Title level={2}>Review 任务</Title>
          <Paragraph type="secondary">MR 与手动 Code Review 共用同一个串行队列，按照进入时间依次执行。</Paragraph>
        </div>
        <Space>
          <Select<ReviewView>
            value={view}
            onChange={onViewChange}
            style={{ width: 150 }}
            aria-label="Review 任务筛选"
            options={[
              { value: "all", label: "全部任务" },
              { value: "queued", label: "排队任务" },
              { value: "completed", label: "完成 Review" },
              { value: "findings", label: "发现问题" }
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void loadTasks()} loading={loading}>刷新队列</Button>
        </Space>
      </section>
      {loadError ? (
        <Alert
          type="warning"
          showIcon
          message="Review 队列暂时不可用"
          description={loadError}
          action={<Button size="small" onClick={() => void loadTasks()}>重新连接</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Card bordered={false} className="content-card">
        <Table<ReviewTask>
          rowKey="id"
          loading={loading}
          dataSource={visibleTasks}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 Review 任务" /> }}
          scroll={{ x: 1280 }}
          columns={[
            {
              title: "项目",
              dataIndex: "projectName",
              width: 150,
              render: (value: string, task) => <Button type="link" className="project-name-link" onClick={() => onProjectOpen(task.projectId)}>{value}</Button>
            },
            {
              title: "来源",
              dataIndex: "triggerType",
              width: 105,
              render: (value: ReviewTask["triggerType"]) => <Tag color={value === "manual" ? "purple" : "blue"}>{value === "manual" ? "手动" : "GitLab MR"}</Tag>
            },
            {
              title: "审查范围",
              key: "mergeRequest",
              width: 280,
              render: (_value, task) => (
                <div>
                  {task.triggerType === "manual"
                    ? <Text strong>{task.mergeRequestTitle}</Text>
                    : task.mergeRequestUrl
                      ? <a href={task.mergeRequestUrl} target="_blank" rel="noreferrer">!{task.mergeRequestIid} {task.mergeRequestTitle}</a>
                      : <Text>!{task.mergeRequestIid} {task.mergeRequestTitle}</Text>}
                  <div><Text type="secondary">{task.sourceBranch} → {task.targetBranch}</Text></div>
                </div>
              )
            },
            { title: "提交", dataIndex: "headSha", width: 130, render: (value: string) => value ? <Text code>{value.slice(0, 10)}</Text> : <Text type="secondary">分支范围</Text> },
            { title: "提交人", dataIndex: "authorName", width: 130 },
            {
              title: "状态",
              dataIndex: "status",
              width: 145,
              render: (status: ReviewTask["status"], task) => (
                <Tooltip title={task.error}>
                  <Tag color={reviewStatusMeta[status].color}>{reviewStatusMeta[status].label}</Tag>
                </Tooltip>
              )
            },
            {
              title: "Review 结果",
              key: "result",
              width: 170,
              render: (_value, task) => task.result ? (
                <Space direction="vertical" size={2}>
                  <Tag color={task.result.findings.length > 0 ? "warning" : "success"}>
                    {task.result.findings.length} 个问题
                  </Tag>
                  <Text type="secondary">风险：{task.result.riskLevel}</Text>
                </Space>
              ) : <Text type="secondary">—</Text>
            },
            { title: "进入队列", dataIndex: "createdAt", width: 175, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            {
              title: "操作",
              key: "actions",
              width: 150,
              fixed: "right",
              render: (_value, task) => (
                <Space size={6}>
                  {task.triggerType === "manual" ? (
                    task.result
                      ? <Button type="link" size="small" onClick={() => setResultTask(task)}>查看结果</Button>
                      : <Button type="link" size="small" onClick={() => onProjectOpen(task.projectId, task.id)}>查看任务</Button>
                  ) : null}
                  {task.gitlabNoteUrl ? <a href={task.gitlabNoteUrl} target="_blank" rel="noreferrer">查看评论</a> : null}
                  {task.status === "failed" ? <Button size="small" onClick={() => void retryTask(task)}>重试</Button> : null}
                  {task.triggerType !== "manual" && !task.gitlabNoteUrl && task.status !== "failed" ? "—" : null}
                </Space>
              )
            }
          ]}
        />
      </Card>
      <ReviewResultModal task={resultTask} onClose={() => setResultTask(undefined)} />
    </>
  );
}

function SettingsPage({
  config,
  saving,
  activeSection,
  onSectionChange,
  onSave
}: {
  config: GroupNodeConfig;
  saving: boolean;
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onSave: (input: GroupNodeConfigUpdate) => Promise<void>;
}) {
  return (
    <>
      <section className="page-heading workspace-heading">
        <div>
          <Title level={2}>项目组设置</Title>
          <Paragraph type="secondary">设置只保存在当前项目组节点；密钥加密后不会返回到浏览器。</Paragraph>
        </div>
      </section>
      <Card bordered={false} className="content-card settings-card">
        <Tabs
          tabPosition="left"
          activeKey={activeSection}
          onChange={(key) => onSectionChange(key as SettingsSection)}
          items={[
            {
              key: "general",
              label: <Space><DatabaseOutlined />基础与仓库</Space>,
              children: <GeneralForm key={config.revision} config={config} saving={saving} onSave={onSave} />
            },
            {
              key: "gitlab",
              label: <Space><CloudServerOutlined />GitLab</Space>,
              children: <GitLabForm key={config.revision} config={config} saving={saving} onSave={onSave} />
            },
            {
              key: "ai",
              label: <Space><RobotOutlined />DeepSeek Review</Space>,
              children: <AiForm key={config.revision} config={config} saving={saving} onSave={onSave} />
            },
            {
              key: "feishu",
              label: <Space><BellOutlined />飞书通知</Space>,
              children: <FeishuForm key={config.revision} config={config} saving={saving} onSave={onSave} />
            }
          ]}
        />
      </Card>
    </>
  );
}

function FormActions({ saving }: { saving: boolean }) {
  return <Button type="primary" htmlType="submit" loading={saving} icon={<SaveOutlined />}>保存设置</Button>;
}

function GeneralForm({ config, saving, onSave }: FormProps) {
  return (
    <Form
      layout="vertical"
      initialValues={{ general: config.general, repository: config.repository }}
      onFinish={(values) => void onSave(values as GroupNodeConfigUpdate)}
      className="settings-form"
    >
      <Title level={4}>基础信息</Title>
      <Row gutter={16}>
        <Col xs={24} md={12}><Form.Item name={["general", "displayName"]} label="显示名称" rules={[{ required: true }]}><Input /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item name={["general", "timezone"]} label="时区"><Select options={[{ value: "Asia/Shanghai", label: "Asia/Shanghai" }, { value: "UTC", label: "UTC" }]} /></Form.Item></Col>
      </Row>
      <Form.Item name={["general", "description"]} label="项目组说明"><Input.TextArea rows={3} /></Form.Item>
      <Form.Item name={["general", "reviewLanguage"]} label="默认评论语言"><Select style={{ maxWidth: 280 }} options={[{ value: "zh-CN", label: "中文" }, { value: "en-US", label: "English" }]} /></Form.Item>

      <Title level={4} className="form-section-title">本地仓库</Title>
      <Form.Item
        name={["repository", "rootPath"]}
        label="仓库根目录"
        extra="该项目组下所有项目的本地仓库都存放在这里；Review 任务会串行复用对应项目仓库。"
        rules={[{ required: true }]}
      >
        <Input prefix={<FolderOpenOutlined />} />
      </Form.Item>
      <Row gutter={16}>
        <Col xs={24} md={12}><Form.Item name={["repository", "cloneDepth"]} label="Clone Depth"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item name={["repository", "maxDiskGigabytes"]} label="最大磁盘 GB"><InputNumber min={1} style={{ width: "100%" }} /></Form.Item></Col>
      </Row>
      <FormActions saving={saving} />
    </Form>
  );
}

interface FormProps {
  config: GroupNodeConfig;
  saving: boolean;
  onSave: (input: GroupNodeConfigUpdate) => Promise<void>;
}

function GitLabForm({ config, saving, onSave }: FormProps) {
  return (
    <Form layout="vertical" initialValues={{ gitlab: config.gitlab }} onFinish={(values) => void onSave(values as GroupNodeConfigUpdate)} className="settings-form">
      <Flex justify="space-between" align="center"><Title level={4}>GitLab 连接</Title><ConfigTag configured={config.gitlab.tokenConfigured && Boolean(config.gitlab.baseUrl)} /></Flex>
      <Form.Item name={["gitlab", "baseUrl"]} label="GitLab Base URL" rules={[{ type: "url", warningOnly: true }]}><Input placeholder="https://gitlab.example.com" /></Form.Item>
      <Form.Item name={["gitlab", "apiUrl"]} label="API URL" rules={[{ type: "url", warningOnly: true }]}><Input placeholder="https://gitlab.example.com/api/v4" /></Form.Item>
      <Form.Item name={["gitlab", "token"]} label="Access Token" extra={config.gitlab.tokenConfigured ? "已经配置 Token，留空不会修改。" : "Token 将在项目组节点本地加密保存。"}><Input.Password placeholder={config.gitlab.tokenConfigured ? "已配置，留空不修改" : "输入 Access Token"} autoComplete="new-password" /></Form.Item>
      <Row gutter={16}>
        <Col xs={24} md={12}><Form.Item name={["gitlab", "requestTimeoutSeconds"]} label="请求超时（秒）"><InputNumber min={1} style={{ width: "100%" }} /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item name={["gitlab", "sslVerification"]} label="SSL 证书验证" valuePropName="checked"><Switch /></Form.Item></Col>
      </Row>
      <FormActions saving={saving} />
    </Form>
  );
}

function AiForm({ config, saving, onSave }: FormProps) {
  const configured = Boolean(config.ai.apiKeyConfigured && config.ai.model && config.ai.reviewPrompt);
  return (
    <Form layout="vertical" initialValues={{ ai: config.ai }} onFinish={(values) => void onSave(values as GroupNodeConfigUpdate)} className="settings-form">
      <Flex justify="space-between" align="flex-start" gap={16} className="ai-settings-heading">
        <div>
          <Title level={4}>DeepSeek Review</Title>
          <Paragraph type="secondary">配置当前项目组使用的模型、执行策略与统一审查规则。</Paragraph>
        </div>
        <ConfigTag configured={configured} />
      </Flex>
      <Alert
        type={configured ? "success" : "info"}
        showIcon
        message={configured ? "DeepSeek Review 已就绪" : "完成 API Key 和模型配置后即可开始 Review"}
        description="敏感凭据只在当前项目组节点加密保存；不同项目组之间完全隔离。"
        className="ai-settings-alert"
      />

      <Card
        size="small"
        className="ai-setting-block"
        title={<Space><ApiOutlined />连接与凭据</Space>}
        extra={config.ai.apiKeyConfigured ? <Tag color="success">Key 已配置</Tag> : <Tag>等待配置</Tag>}
      >
        <Form.Item name={["ai", "baseUrl"]} label="DeepSeek API 地址" rules={[{ required: true }, { type: "url" }]} extra="一般保持默认地址；使用企业网关时再修改。"><Input placeholder="https://api.deepseek.com/anthropic" /></Form.Item>
        <Form.Item name={["ai", "apiKey"]} label="DeepSeek API Key" extra={config.ai.apiKeyConfigured ? "已安全保存；留空表示继续使用当前 Key。" : "保存后将加密存储在当前项目组节点。"}><Input.Password placeholder={config.ai.apiKeyConfigured ? "已配置，留空不修改" : "输入 DeepSeek API Key"} autoComplete="new-password" /></Form.Item>
      </Card>

      <Card size="small" className="ai-setting-block" title={<Space><RobotOutlined />模型策略</Space>}>
        <Form.Item name={["ai", "model"]} label="审查模型" rules={[{ required: true }]} extra="负责理解代码差异并生成最终 Review 结论。"><Input placeholder="deepseek-v4-pro[1m]" /></Form.Item>
        <Collapse
          ghost
          className="ai-advanced-settings"
          items={[{
            key: "advanced",
            label: <Space><SettingOutlined />高级模型与执行设置</Space>,
            children: (
              <>
                <Row gutter={16}>
                  <Col xs={24} md={12}><Form.Item name={["ai", "fastModel"]} label="快速任务模型" extra="用于轻量分析任务。"><Input placeholder="deepseek-v4-flash" /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={["ai", "subagentModel"]} label="辅助 Agent 模型" extra="用于拆分后的辅助审查任务。"><Input placeholder="deepseek-v4-flash" /></Form.Item></Col>
                </Row>
                <Row gutter={16}>
                  <Col xs={24} md={12}><Form.Item name={["ai", "reasoningEffort"]} label="审查深度"><Select options={[{ value: "low", label: "快速" }, { value: "medium", label: "标准" }, { value: "high", label: "深入" }, { value: "xhigh", label: "深度" }, { value: "max", label: "最高" }]} /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={["ai", "requestTimeoutSeconds"]} label="单次 Review 超时（秒）" extra="大型仓库建议至少 600 秒。"><InputNumber min={60} max={1800} style={{ width: "100%" }} /></Form.Item></Col>
                </Row>
              </>
            )
          }]}
        />
      </Card>

      <Card size="small" className="ai-setting-block" title={<Space><SafetyCertificateOutlined />Review 规则</Space>}>
        <Form.Item
          name={["ai", "reviewPrompt"]}
          label="团队统一提示词"
          rules={[{ required: true, min: 20 }]}
          extra="系统会自动补充 MR、分支、Commit 和输出格式，无需在这里重复填写。"
          style={{ marginBottom: 0 }}
        >
          <Input.TextArea rows={12} showCount maxLength={20000} placeholder="描述需要重点检查的问题、团队规范和风险偏好。" />
        </Form.Item>
      </Card>
      <FormActions saving={saving} />
    </Form>
  );
}

function FeishuForm({ config, saving, onSave }: FormProps) {
  return (
    <Form layout="vertical" initialValues={{ feishu: config.feishu }} onFinish={(values) => void onSave(values as GroupNodeConfigUpdate)} className="settings-form">
      <Flex justify="space-between" align="center"><Title level={4}>飞书机器人通知</Title><ConfigTag configured={config.feishu.enabled && config.feishu.webhookConfigured} disabled={!config.feishu.enabled} /></Flex>
      <Form.Item name={["feishu", "enabled"]} label="启用通知" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name={["feishu", "name"]} label="配置名称"><Input placeholder="G001 Code Review 群" /></Form.Item>
      <Form.Item name={["feishu", "webhookUrl"]} label="机器人 Webhook URL" extra={config.feishu.webhookConfigured ? "已经配置 Webhook，留空不会修改。" : "Webhook 地址将在节点本地加密保存。"}><Input.Password placeholder={config.feishu.webhookConfigured ? "已配置，留空不修改" : "输入 Webhook URL"} autoComplete="new-password" /></Form.Item>
      <Form.Item name={["feishu", "signingSecret"]} label="签名密钥" extra={config.feishu.signingSecretConfigured ? "已经配置签名密钥，留空不会修改。" : undefined}><Input.Password placeholder={config.feishu.signingSecretConfigured ? "已配置，留空不修改" : "可选"} autoComplete="new-password" /></Form.Item>
      <Title level={5} className="form-section-title">通知事件</Title>
      <Space direction="vertical" size={10}>
        <Form.Item name={["feishu", "notifyOnMergeRequestTriggered"]} valuePropName="checked" noStyle><Switch checkedChildren="MR 触发" unCheckedChildren="MR 触发" /></Form.Item>
        <Form.Item name={["feishu", "notifyOnManualReviewCompleted"]} valuePropName="checked" noStyle><Switch checkedChildren="手动 Code Review" unCheckedChildren="手动 Code Review" /></Form.Item>
        <Form.Item name={["feishu", "notifyOnReviewCompleted"]} valuePropName="checked" noStyle><Switch checkedChildren="Review 完成" unCheckedChildren="Review 完成" /></Form.Item>
        <Form.Item name={["feishu", "notifyOnReviewFailed"]} valuePropName="checked" noStyle><Switch checkedChildren="Review 失败" unCheckedChildren="Review 失败" /></Form.Item>
        <Form.Item name={["feishu", "notifyOnCriticalFinding"]} valuePropName="checked" noStyle><Switch checkedChildren="严重问题" unCheckedChildren="严重问题" /></Form.Item>
      </Space>
      <div className="form-actions-spaced"><FormActions saving={saving} /></div>
    </Form>
  );
}

function ConfigTag({ configured, disabled = false }: { configured: boolean; disabled?: boolean }) {
  if (disabled) return <Tag>已关闭</Tag>;
  return <Tag color={configured ? "success" : "warning"}>{configured ? "已配置" : "待配置"}</Tag>;
}
