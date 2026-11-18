/**
 * AIToolService.ts
 *
 * Defines and executes Tool Calling capabilities for internal Deplao AI assistants.
 * - Read tools execute automatically during the tool-calling loop.
 * - Write tools generate human-in-the-loop confirmation cards (`AIPendingToolAction`)
 *   and only execute after explicit user approval.
 * - Hard Anti-Delete Policy: ONLY Create, Read, and Update actions exist. Data deletion is strictly prohibited.
 */

import DatabaseService from '../database/DatabaseService';
import ErpEmployeeService from '../erp/ErpEmployeeService';
import ErpTaskService from '../erp/ErpTaskService';
import ErpCalendarService from '../erp/ErpCalendarService';
import ErpNoteService from '../erp/ErpNoteService';
import IntegrationRegistry from '../integrations/IntegrationRegistry';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import {
  normalizeAIToolPermissions,
  type AIContextFilter,
  type AIPendingToolAction,
  type AIToolCall,
  type AIToolDefinition,
  type AIToolPermissions,
} from '../../models/ai/ai';

const DESTRUCTIVE_TOOL_REGEX = /^(delete|remove|drop|destroy|purge|clear|truncate)_/i;

const READ_TOOLS: AIToolDefinition[] = [
  {
    name: 'query_messages',
    kind: 'read',
    module: 'messaging',
    description: 'Tìm kiếm và đọc lịch sử tin nhắn đa kênh (Zalo, Facebook, Telegram) theo khoảng thời gian, tên hội thoại, loại 1-1/nhóm hoặc từ khóa.',
    parameters: {
      type: 'object',
      properties: {
        timePreset: {
          type: 'string',
          enum: ['all', 'today', 'yesterday', '7d', '30d'],
          description: 'Khoảng thời gian lọc nhanh.',
        },
        fromIso: { type: 'string', description: 'Ngày bắt đầu định dạng ISO (VD: 2026-11-01T00:00:00).' },
        toIso: { type: 'string', description: 'Ngày kết thúc định dạng ISO.' },
        threadSearch: { type: 'string', description: 'Tên hoặc từ khóa tên hội thoại / khách hàng / nhóm cần tìm.' },
        threadType: { type: 'string', enum: ['all', 'direct', 'group'], description: 'Lọc hội thoại cá nhân 1-1 hoặc nhóm.' },
        channel: { type: 'string', enum: ['zalo', 'facebook', 'telegram_user', 'telegram_bot'], description: 'Lọc theo kênh.' },
        labelName: { type: 'string', description: 'Lọc theo tên Nhãn Zalo hoặc Nhãn Deplao / Tag CRM (VD: AI Dũng, Dự án, Khách VIP).' },
        keyword: { type: 'string', description: 'Từ khóa xuất hiện trong nội dung tin nhắn.' },
        limit: { type: 'number', description: 'Số tin nhắn tối đa cần lấy (1..200, mặc định 50).' },
      },
    },
  },
  {
    name: 'list_conversations',
    kind: 'read',
    module: 'messaging',
    description: 'Liệt kê danh sách các hội thoại gần đây hoặc chưa đọc trên Zalo, Facebook, Telegram.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Lọc theo tên hiển thị hoặc SĐT.' },
        channel: { type: 'string', enum: ['zalo', 'facebook', 'telegram_user', 'telegram_bot'], description: 'Kênh cần lọc.' },
        threadType: { type: 'string', enum: ['all', 'direct', 'group'], description: 'Cá nhân hay nhóm.' },
        labelName: { type: 'string', description: 'Lọc theo tên Nhãn Zalo hoặc Nhãn Deplao / Tag CRM (VD: AI Dũng, Dự án).' },
        unreadOnly: { type: 'boolean', description: 'Chỉ lấy hội thoại có tin chưa đọc.' },
        limit: { type: 'number', description: 'Số lượng hội thoại tối đa (1..50, mặc định 20).' },
      },
    },
  },
  {
    name: 'lookup_crm_contacts',
    kind: 'read',
    module: 'crm',
    description: 'Tra cứu thông tin khách hàng / liên hệ CRM (SĐT, biệt danh, sinh nhật, giới tính), nhãn Deplao, tag CRM, nhãn Zalo và lịch sử ghi chú CRM.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tên, biệt danh, SĐT hoặc ID liên hệ cần tra cứu.' },
        labelName: { type: 'string', description: 'Lọc khách hàng theo tên nhãn.' },
        accountId: { type: 'string', description: 'Lọc theo ID tài khoản sở hữu.' },
        contactType: { type: 'string', enum: ['all', 'user', 'group'], description: 'Cá nhân hay nhóm.' },
        limit: { type: 'number', description: 'Số liên hệ tối đa (1..40, mặc định 15).' },
      },
    },
  },
  {
    name: 'list_crm_tags_and_campaigns',
    kind: 'read',
    module: 'crm',
    description: 'Xem danh sách Nhãn Deplao (local_labels), Tag CRM, Nhãn Zalo và danh sách Chiến dịch CRM kèm thống kê đã gửi/chờ/lỗi.',
    parameters: {
      type: 'object',
      properties: {
        include: { type: 'string', enum: ['all', 'tags', 'campaigns'], description: 'Cần lấy nhãn hay chiến dịch hay cả hai.' },
        accountId: { type: 'string', description: 'Lọc theo ID tài khoản (owner_zalo_id).' },
      },
    },
  },
  {
    name: 'list_org_structure',
    kind: 'read',
    module: 'hrm',
    description: 'Xem cơ cấu tổ chức: danh sách Phòng ban, Chức vụ và Nhân sự (hồ sơ, phòng ban, chức vụ, quản lý trực tiếp, vai trò ERP).',
    parameters: {
      type: 'object',
      properties: {
        include: { type: 'string', enum: ['all', 'departments', 'positions', 'employees'], description: 'Loại dữ liệu cơ cấu tổ chức.' },
        departmentId: { type: 'number', description: 'Lọc nhân sự/chức vụ theo ID phòng ban.' },
        search: { type: 'string', description: 'Từ khóa tên phòng ban, chức vụ hoặc nhân viên.' },
      },
    },
  },
  {
    name: 'list_hrm_records',
    kind: 'read',
    module: 'hrm',
    description: 'Xem dữ liệu Chấm công (Attendance) và Đơn xin nghỉ phép (Leave Requests) của nhân sự.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'attendance', 'leaves'], description: 'Loại hồ sơ HRM.' },
        employeeId: { type: 'string', description: 'Lọc theo ID nhân viên.' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled'], description: 'Lọc trạng thái đơn nghỉ phép.' },
        fromDate: { type: 'string', description: 'Ngày bắt đầu YYYY-MM-DD.' },
        toDate: { type: 'string', description: 'Ngày kết thúc YYYY-MM-DD.' },
      },
    },
  },
  {
    name: 'list_projects_and_tasks',
    kind: 'read',
    module: 'tasks',
    description: 'Xem danh sách Dự án (Projects) và Công việc (Tasks) theo phòng ban, nhân sự, trạng thái, hạn hoàn thành; hoặc xem chi tiết 1 Task (checklist, bình luận, phụ thuộc).',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Truyền taskId nếu muốn xem chi tiết đầy đủ 1 công việc (gồm checklist, comment, activity).' },
        includeProjects: { type: 'boolean', description: 'Kèm danh sách dự án (mặc định true).' },
        projectId: { type: 'string', description: 'Lọc công việc theo ID dự án.' },
        departmentId: { type: 'number', description: 'Lọc dự án/công việc theo ID phòng ban.' },
        assigneeId: { type: 'string', description: 'Lọc theo ID người được giao.' },
        status: { type: 'string', enum: ['todo', 'doing', 'review', 'done', 'cancelled'], description: 'Trạng thái task.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Độ ưu tiên.' },
        dueFilter: { type: 'string', enum: ['all', 'overdue', 'today', 'this_week', 'upcoming'], description: 'Lọc theo hạn hoàn thành.' },
        search: { type: 'string', description: 'Từ khóa tên dự án hoặc tiêu đề công việc.' },
        limit: { type: 'number', description: 'Số task tối đa (1..100, mặc định 40).' },
      },
    },
  },
  {
    name: 'list_calendar_and_notes',
    kind: 'read',
    module: 'calendar_notes',
    description: 'Xem Lịch hẹn (Calendar events), Thư mục ghi chú và Ghi chú / Tài liệu nội bộ (ERP Notes).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'events', 'notes', 'folders'], description: 'Loại dữ liệu.' },
        noteId: { type: 'string', description: 'ID ghi chú nếu muốn đọc toàn bộ nội dung.' },
        folderId: { type: 'number', description: 'Lọc ghi chú theo ID thư mục.' },
        search: { type: 'string', description: 'Từ khóa tiêu đề/nội dung.' },
        daysBack: { type: 'number', description: 'Số ngày quá khứ cho lịch hẹn (mặc định 3).' },
        daysAhead: { type: 'number', description: 'Số ngày tới cho lịch hẹn (mặc định 14).' },
      },
    },
  },
  {
    name: 'generate_work_report',
    kind: 'read',
    module: 'reports',
    description: 'Tổng hợp số liệu & lập báo cáo công việc toàn diện: tiến độ Task theo trạng thái, việc quá hạn/sắp đến hạn, hiệu suất theo Dự án / Phòng ban / Nhân sự, chấm công - nghỉ phép và thống kê tin nhắn / CRM.',
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', '7d', '30d', 'this_month', 'custom'],
          description: 'Kỳ báo cáo (mặc định 7d).',
        },
        fromIso: { type: 'string', description: 'Ngày bắt đầu ISO khi period=custom.' },
        toIso: { type: 'string', description: 'Ngày kết thúc ISO khi period=custom.' },
        departmentId: { type: 'number', description: 'Giới hạn báo cáo theo ID phòng ban (tuỳ chọn).' },
        projectId: { type: 'string', description: 'Giới hạn báo cáo theo ID dự án (tuỳ chọn).' },
        employeeId: { type: 'string', description: 'Giới hạn báo cáo theo ID nhân viên (tuỳ chọn).' },
      },
    },
  },
  {
    name: 'lookup_pos',
    kind: 'read',
    module: 'pos',
    description: 'Tra cứu sản phẩm, đơn hàng hoặc khách hàng từ phần mềm bán hàng POS đã kết nối (KiotViet, Sapo, Haravan, Nhanh, Pancake...).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lookupProduct', 'lookupOrder', 'lookupCustomer'], description: 'Hành động tra cứu.' },
        keyword: { type: 'string', description: 'Tên hoặc mã sản phẩm.' },
        phone: { type: 'string', description: 'Số điện thoại khách hàng.' },
        orderId: { type: 'string', description: 'Mã đơn hàng.' },
      },
      required: ['action'],
    },
  },
];

const WRITE_TOOLS: AIToolDefinition[] = [
  // ── HRM / Phòng ban, Chức vụ & Nhân sự ──
  {
    name: 'manage_departments',
    kind: 'write',
    module: 'hrm',
    description: 'Tạo mới hoặc cập nhật một hay nhiều Phòng ban cùng lúc (KHÔNG xóa). Nếu truyền `id` sẽ cập nhật; nếu không truyền `id` sẽ tạo mới (hoặc cập nhật nếu trùng tên). Dùng mảng `items` khi cần tạo nhiều phòng ban một lần.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID phòng ban cần cập nhật (bỏ trống nếu tạo mới).' },
        name: { type: 'string', description: 'Tên phòng ban (khi thao tác 1 phòng ban).' },
        parentId: { type: 'number', description: 'ID phòng ban cha (nếu có).' },
        parentName: { type: 'string', description: 'Tên phòng ban cha (tự đối chiếu nếu chưa có parentId).' },
        managerEmployeeId: { type: 'string', description: 'ID nhân viên trưởng phòng (nếu có).' },
        description: { type: 'string', description: 'Mô tả chức năng, nhiệm vụ phòng ban.' },
        items: {
          type: 'array',
          description: 'Danh sách nhiều phòng ban cần tạo/cập nhật cùng lúc.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              parentId: { type: 'number' },
              parentName: { type: 'string' },
              managerEmployeeId: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
    },
  },
  {
    name: 'manage_positions',
    kind: 'write',
    module: 'hrm',
    description: 'Tạo mới hoặc cập nhật một hay nhiều Chức vụ / Vị trí công việc (KHÔNG xóa). Hỗ trợ gắn vào phòng ban theo ID hoặc tên và thiết lập cấp bậc (level).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID chức vụ nếu cập nhật.' },
        name: { type: 'string', description: 'Tên chức vụ (VD: Trưởng phòng Kinh doanh, Lập trình viên).' },
        level: { type: 'number', description: 'Cấp bậc (số càng lớn chức vụ càng cao, VD: 1=Nhân viên, 2=Trưởng nhóm, 3=Trưởng phòng, 4=Giám đốc).' },
        departmentId: { type: 'number', description: 'ID phòng ban áp dụng.' },
        departmentName: { type: 'string', description: 'Tên phòng ban (tự tìm departmentId).' },
        items: {
          type: 'array',
          description: 'Danh sách nhiều chức vụ cần tạo/cập nhật cùng lúc.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              level: { type: 'number' },
              departmentId: { type: 'number' },
              departmentName: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
    },
  },
  {
    name: 'update_employee_profile',
    kind: 'write',
    module: 'hrm',
    description: 'Phân bổ phòng ban, chức vụ, quản lý trực tiếp, vai trò ERP hoặc cập nhật hồ sơ cho một hoặc nhiều nhân sự (KHÔNG xóa nhân sự).',
    parameters: {
      type: 'object',
      properties: {
        employeeId: { type: 'string', description: 'ID nhân viên (employee_id).' },
        employeeName: { type: 'string', description: 'Tên nhân viên (dùng tra cứu nếu chưa có employeeId).' },
        departmentId: { type: 'number', description: 'ID phòng ban.' },
        departmentName: { type: 'string', description: 'Tên phòng ban (tự đối chiếu ID).' },
        positionId: { type: 'number', description: 'ID chức vụ.' },
        positionName: { type: 'string', description: 'Tên chức vụ (tự đối chiếu ID).' },
        managerEmployeeId: { type: 'string', description: 'ID quản lý trực tiếp.' },
        erpRole: { type: 'string', enum: ['owner', 'admin', 'manager', 'member', 'guest'], description: 'Vai trò ERP.' },
        phone: { type: 'string' },
        email: { type: 'string' },
        gender: { type: 'string' },
        address: { type: 'string' },
        items: {
          type: 'array',
          description: 'Cập nhật hàng loạt nhiều nhân sự.',
          items: {
            type: 'object',
            properties: {
              employeeId: { type: 'string' },
              employeeName: { type: 'string' },
              departmentId: { type: 'number' },
              departmentName: { type: 'string' },
              positionId: { type: 'number' },
              positionName: { type: 'string' },
              managerEmployeeId: { type: 'string' },
              erpRole: { type: 'string', enum: ['owner', 'admin', 'manager', 'member', 'guest'] },
              phone: { type: 'string' },
              email: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'record_hrm_leave_or_attendance',
    kind: 'write',
    module: 'hrm',
    description: 'Chấm công (check-in/check-out), tạo đơn xin nghỉ phép hoặc duyệt/từ chối đơn nghỉ phép đang chờ (KHÔNG xóa dữ liệu).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_leave', 'decide_leave', 'check_in', 'check_out'],
          description: 'Loại thao tác HRM.',
        },
        employeeId: { type: 'string', description: 'ID nhân viên (mặc định boss nếu chấm công/tạo đơn cho chủ tài khoản).' },
        leaveType: { type: 'string', enum: ['annual', 'sick', 'unpaid', 'other'], description: 'Loại nghỉ phép.' },
        startDate: { type: 'string', description: 'Ngày bắt đầu YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'Ngày kết thúc YYYY-MM-DD.' },
        days: { type: 'number', description: 'Số ngày nghỉ.' },
        reason: { type: 'string', description: 'Lý do nghỉ phép.' },
        leaveId: { type: 'number', description: 'ID đơn nghỉ phép khi action=decide_leave.' },
        leaveDecision: { type: 'string', enum: ['approved', 'rejected'], description: 'Duyệt hoặc từ chối đơn nghỉ phép.' },
        note: { type: 'string', description: 'Ghi chú chấm công hoặc lý do duyệt/từ chối.' },
      },
      required: ['action'],
    },
  },

  // ── Quản lý Dự án & Công việc (Tasks) ──
  {
    name: 'manage_erp_project',
    kind: 'write',
    module: 'tasks',
    description: 'Tạo mới hoặc cập nhật Dự án trong Quản lý công việc ERP (KHÔNG xóa dự án).',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'ID dự án cần sửa (bỏ trống nếu tạo dự án mới).' },
        name: { type: 'string', description: 'Tên dự án.' },
        description: { type: 'string', description: 'Mô tả mục tiêu dự án.' },
        color: { type: 'string', description: 'Mã màu HEX (VD: #3b82f6).' },
        departmentId: { type: 'number', description: 'ID phòng ban phụ trách.' },
        departmentName: { type: 'string', description: 'Tên phòng ban phụ trách (tự đối chiếu ID).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_erp_task',
    kind: 'write',
    module: 'tasks',
    description: 'Tạo một hoặc nhiều Công việc (Task) mới trong ERP, hỗ trợ gắn vào dự án, giao cho nhân sự, đặt hạn và kèm checklist đầu việc.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tiêu đề công việc ngắn gọn, rõ ràng.' },
        description: { type: 'string', description: 'Mô tả chi tiết nội dung cần làm.' },
        projectId: { type: 'string', description: 'ID dự án (nếu có).' },
        projectName: { type: 'string', description: 'Tên dự án (tự đối chiếu hoặc tự chọn dự án trùng tên).' },
        parentTaskId: { type: 'string', description: 'ID task cha nếu là việc con.' },
        status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: 'Trạng thái ban đầu (mặc định todo).' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Độ ưu tiên.' },
        startDateIso: { type: 'string', description: 'Ngày bắt đầu ISO.' },
        dueDateIso: { type: 'string', description: 'Hạn hoàn thành định dạng ISO (VD: 2026-11-20T17:00:00).' },
        estimatedHours: { type: 'number', description: 'Số giờ ước tính.' },
        assigneeIds: { type: 'array', items: { type: 'string' }, description: 'Danh sách employee_id được giao việc.' },
        linkedContactId: { type: 'string', description: 'ID liên hệ khách hàng liên quan (nếu có).' },
        checklistItems: { type: 'array', items: { type: 'string' }, description: 'Các bước checklist con cần tạo kèm.' },
        items: {
          type: 'array',
          description: 'Tạo nhiều công việc cùng lúc.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              projectId: { type: 'string' },
              projectName: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
              dueDateIso: { type: 'string' },
              estimatedHours: { type: 'number' },
              assigneeIds: { type: 'array', items: { type: 'string' } },
              checklistItems: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
      },
    },
  },
  {
    name: 'update_erp_task',
    kind: 'write',
    module: 'tasks',
    description: 'Cập nhật trạng thái, độ ưu tiên, hạn hoàn thành, dự án, giờ thực tế hoặc giao thêm/thay người thực hiện cho Công việc ERP (KHÔNG xóa/hủy task).',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID công việc cần cập nhật.' },
        title: { type: 'string' },
        description: { type: 'string' },
        projectId: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: 'Trạng thái mới.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        startDateIso: { type: 'string' },
        dueDateIso: { type: 'string' },
        estimatedHours: { type: 'number' },
        actualHours: { type: 'number' },
        assigneeIds: { type: 'array', items: { type: 'string' }, description: 'Danh sách ID nhân sự được giao.' },
        assigneeMode: { type: 'string', enum: ['add', 'replace'], description: 'add = giữ người cũ + thêm người mới (mặc định); replace = thay danh sách người mới.' },
        dependsOnTaskId: { type: 'string', description: 'ID task tiền đề cần hoàn thành trước (nếu có).' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'manage_task_checklist_and_comments',
    kind: 'write',
    module: 'tasks',
    description: 'Thêm mục checklist mới, đánh dấu hoàn thành/chưa hoàn thành checklist, hoặc thêm/chỉnh sửa bình luận trao đổi trên 1 Task (KHÔNG xóa).',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID công việc.' },
        addChecklistItems: { type: 'array', items: { type: 'string' }, description: 'Các mục checklist cần thêm mới.' },
        toggleChecklistItems: {
          type: 'array',
          description: 'Đánh dấu trạng thái hoàn thành của các mục checklist có sẵn.',
          items: {
            type: 'object',
            properties: {
              checklistId: { type: 'number' },
              done: { type: 'boolean' },
            },
            required: ['checklistId', 'done'],
          },
        },
        commentId: { type: 'number', description: 'Truyền nếu sửa bình luận có sẵn.' },
        commentContent: { type: 'string', description: 'Nội dung bình luận mới hoặc cần cập nhật.' },
      },
      required: ['taskId'],
    },
  },

  // ── Lịch hẹn & Ghi chú ERP ──
  {
    name: 'create_erp_event',
    kind: 'write',
    module: 'calendar_notes',
    description: 'Tạo một Lịch hẹn / Cuộc họp / Nhắc lịch mới trong ERP Calendar.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tên lịch hẹn hoặc nhắc nhở.' },
        description: { type: 'string', description: 'Ghi chú lịch hẹn.' },
        startAtIso: { type: 'string', description: 'Thời gian bắt đầu định dạng ISO (VD: 2026-11-19T09:00:00).' },
        endAtIso: { type: 'string', description: 'Thời gian kết thúc định dạng ISO.' },
        type: { type: 'string', enum: ['meeting', 'appointment', 'reminder', 'task'], description: 'Loại sự kiện.' },
        location: { type: 'string', description: 'Địa điểm hoặc link họp online.' },
        allDay: { type: 'boolean', description: 'Sự kiện cả ngày.' },
        attendeeIds: { type: 'array', items: { type: 'string' }, description: 'Danh sách ID nhân sự được mời.' },
        linkedTaskId: { type: 'string', description: 'ID task liên kết (nếu có).' },
        linkedContactId: { type: 'string', description: 'ID khách hàng liên kết (nếu có).' },
        reminderMinutes: { type: 'number', description: 'Nhắc trước bao nhiêu phút (mặc định 15).' },
      },
      required: ['title', 'startAtIso'],
    },
  },
  {
    name: 'update_erp_event',
    kind: 'write',
    module: 'calendar_notes',
    description: 'Cập nhật thông tin hoặc dời lịch một Lịch hẹn ERP có sẵn (KHÔNG xóa lịch).',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'ID sự kiện cần sửa.' },
        title: { type: 'string' },
        description: { type: 'string' },
        startAtIso: { type: 'string' },
        endAtIso: { type: 'string' },
        type: { type: 'string', enum: ['meeting', 'appointment', 'reminder', 'task'] },
        location: { type: 'string' },
        reminderMinutes: { type: 'number' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'create_erp_note',
    kind: 'write',
    module: 'calendar_notes',
    description: 'Lưu một Ghi chú / Biên bản / Báo cáo mới vào ERP Notes (có thể chọn hoặc tự tạo thư mục lưu trữ).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tiêu đề ghi chú.' },
        content: { type: 'string', description: 'Nội dung ghi chú (hỗ trợ Markdown).' },
        folderId: { type: 'number', description: 'ID thư mục có sẵn.' },
        folderName: { type: 'string', description: 'Tên thư mục (nếu chưa có sẽ tự tạo thư mục mới).' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'update_erp_note',
    kind: 'write',
    module: 'calendar_notes',
    description: 'Cập nhật nội dung/tiêu đề/ghim của Ghi chú ERP có sẵn, hoặc tạo/đổi tên Thư mục ghi chú (KHÔNG xóa).',
    parameters: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID ghi chú cần cập nhật.' },
        title: { type: 'string' },
        content: { type: 'string' },
        folderId: { type: 'number' },
        pinned: { type: 'boolean' },
        createFolderName: { type: 'string', description: 'Tên thư mục mới cần tạo (nếu chỉ muốn tạo thư mục).' },
        renameFolderId: { type: 'number', description: 'ID thư mục cần đổi tên.' },
        newFolderName: { type: 'string', description: 'Tên mới của thư mục.' },
      },
    },
  },

  // ── CRM (Khách hàng, Ghi chú CRM, Nhãn/Tag, Chiến dịch) ──
  {
    name: 'update_crm_contact',
    kind: 'write',
    module: 'crm',
    description: 'Cập nhật biệt danh (alias), số điện thoại, giới tính hoặc ngày sinh của khách hàng trong CRM (KHÔNG xóa).',
    parameters: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'ID tài khoản sở hữu (owner_zalo_id).' },
        contactId: { type: 'string', description: 'ID liên hệ khách hàng.' },
        contactName: { type: 'string', description: 'Tên hiện tại để hiển thị trên thẻ xác nhận.' },
        alias: { type: 'string', description: 'Tên gợi nhớ / biệt danh riêng.' },
        phone: { type: 'string', description: 'Số điện thoại.' },
        gender: { type: 'string', enum: ['male', 'female', 'other'], description: 'Giới tính.' },
        birthday: { type: 'string', description: 'Ngày sinh (VD: 1995-08-20).' },
      },
      required: ['accountId', 'contactId'],
    },
  },
  {
    name: 'add_crm_note',
    kind: 'write',
    module: 'crm',
    description: 'Thêm mới hoặc cập nhật nội dung một ghi chú chăm sóc trong hồ sơ CRM của khách hàng (KHÔNG xóa).',
    parameters: {
      type: 'object',
      properties: {
        noteId: { type: 'number', description: 'ID ghi chú CRM nếu muốn sửa ghi chú cũ; bỏ trống nếu tạo mới.' },
        accountId: { type: 'string', description: 'ID tài khoản sở hữu (owner_zalo_id).' },
        contactId: { type: 'string', description: 'ID liên hệ / hội thoại (thread_id).' },
        contactName: { type: 'string', description: 'Tên hiển thị liên hệ để người dùng dễ kiểm tra.' },
        content: { type: 'string', description: 'Nội dung ghi chú CRM.' },
      },
      required: ['accountId', 'contactId', 'content'],
    },
  },
  {
    name: 'manage_crm_tag_or_label',
    kind: 'write',
    module: 'crm',
    description: 'Tạo mới hoặc cập nhật Nhãn Deplao (local_label) hoặc Tag CRM, đồng thời có thể gắn nhãn đó cho danh sách khách hàng/hội thoại (KHÔNG xóa nhãn).',
    parameters: {
      type: 'object',
      properties: {
        targetType: { type: 'string', enum: ['local_label', 'crm_tag'], description: 'Loại nhãn (mặc định local_label).' },
        id: { type: 'number', description: 'ID nhãn/tag nếu cập nhật.' },
        name: { type: 'string', description: 'Tên nhãn/tag.' },
        color: { type: 'string', description: 'Mã màu HEX (mặc định #3B82F6).' },
        emoji: { type: 'string', description: 'Emoji hiển thị (VD: ⭐, 🏷️).' },
        accountId: { type: 'string', description: 'ID tài khoản sở hữu (bắt buộc cho crm_tag hoặc khi gắn cho khách hàng).' },
        assignContactIds: { type: 'array', items: { type: 'string' }, description: 'Danh sách ID khách hàng/hội thoại cần gắn nhãn này.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'save_crm_campaign',
    kind: 'write',
    module: 'crm',
    description: 'Tạo mới hoặc cập nhật Chiến dịch CSKH / gửi tin CRM ở trạng thái Nháp (draft) hoặc Tạm dừng (paused) để tránh gửi nhầm hàng loạt, đồng thời có thể thêm danh sách khách hàng mục tiêu (KHÔNG xóa chiến dịch).',
    parameters: {
      type: 'object',
      properties: {
        campaignId: { type: 'number', description: 'ID chiến dịch nếu cập nhật; bỏ trống để tạo mới.' },
        accountId: { type: 'string', description: 'ID tài khoản chạy chiến dịch (owner_zalo_id).' },
        name: { type: 'string', description: 'Tên chiến dịch.' },
        templateMessage: { type: 'string', description: 'Nội dung tin nhắn mẫu.' },
        friendRequestMessage: { type: 'string', description: 'Lời chào kết bạn (nếu loại chiến dịch là friend_request/mixed).' },
        campaignType: { type: 'string', enum: ['message', 'friend_request', 'mixed', 'invite_to_group'], description: 'Loại chiến dịch.' },
        status: { type: 'string', enum: ['draft', 'paused'], description: 'Chỉ lưu draft hoặc paused để người dùng rà soát trước khi chạy.' },
        dailySendLimit: { type: 'number', description: 'Giới hạn số lượt gửi mỗi ngày.' },
        delayMinSeconds: { type: 'number', description: 'Độ trễ tối thiểu giữa các lượt gửi (giây).' },
        delayMaxSeconds: { type: 'number', description: 'Độ trễ tối đa giữa các lượt gửi (giây).' },
        addContacts: {
          type: 'array',
          description: 'Danh sách khách hàng cần thêm vào chiến dịch.',
          items: {
            type: 'object',
            properties: {
              contactId: { type: 'string' },
              displayName: { type: 'string' },
            },
            required: ['contactId'],
          },
        },
      },
      required: ['accountId', 'name'],
    },
  },

  // ── Tin nhắn & Hội thoại (Messaging) ──
  {
    name: 'assign_conversation_label',
    kind: 'write',
    module: 'messaging',
    description: 'Đề xuất gắn nhãn phân loại (Local Label) cho một hội thoại. Người dùng sẽ xác nhận trước khi thực hiện.',
    parameters: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'ID tài khoản sở hữu.' },
        threadId: { type: 'string', description: 'ID hội thoại.' },
        threadName: { type: 'string', description: 'Tên hội thoại.' },
        labelName: { type: 'string', description: 'Tên nhãn cần gắn (VD: Khách VIP, Chờ báo giá).' },
      },
      required: ['accountId', 'threadId', 'labelName'],
    },
  },
  {
    name: 'send_chat_message',
    kind: 'write',
    module: 'messaging',
    description: 'Đề xuất gửi tin nhắn tới một hội thoại Zalo, Facebook hoặc Telegram. LUÔN yêu cầu người dùng bấm nút Xác nhận gửi trên giao diện.',
    parameters: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'ID tài khoản gửi.' },
        channel: { type: 'string', enum: ['zalo', 'facebook', 'telegram_user', 'telegram_bot'], description: 'Kênh gửi.' },
        threadId: { type: 'string', description: 'ID hội thoại đích.' },
        threadName: { type: 'string', description: 'Tên người nhận / nhóm.' },
        threadType: { type: 'number', description: '0 = cá nhân, 1 = nhóm.' },
        message: { type: 'string', description: 'Nội dung tin nhắn dự kiến gửi.' },
      },
      required: ['accountId', 'channel', 'threadId', 'message'],
    },
  },
];

const ALL_TOOLS: AIToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];
const TOOL_MAP = new Map<string, AIToolDefinition>(ALL_TOOLS.map(t => [t.name, t]));
const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map(t => t.name));

const TOOL_LABELS: Record<string, string> = {
  query_messages: 'Đọc & lọc tin nhắn',
  list_conversations: 'Liệt kê hội thoại',
  lookup_crm_contacts: 'Tra cứu CRM & nhãn',
  list_crm_tags_and_campaigns: 'Xem nhãn CRM & chiến dịch',
  list_org_structure: 'Xem Phòng ban, Chức vụ & Nhân sự',
  list_hrm_records: 'Xem Chấm công & Nghỉ phép',
  list_projects_and_tasks: 'Xem Dự án & Công việc',
  list_calendar_and_notes: 'Xem Lịch hẹn & Ghi chú ERP',
  generate_work_report: 'Tổng hợp Báo cáo công việc',
  lookup_pos: 'Tra cứu POS / Đơn hàng',
  manage_departments: 'Tạo/sửa Phòng ban',
  manage_positions: 'Tạo/sửa Chức vụ',
  update_employee_profile: 'Cập nhật hồ sơ Nhân sự',
  record_hrm_leave_or_attendance: 'Chấm công / Nghỉ phép HRM',
  manage_erp_project: 'Tạo/sửa Dự án ERP',
  create_erp_task: 'Tạo công việc ERP',
  update_erp_task: 'Cập nhật công việc ERP',
  manage_task_checklist_and_comments: 'Cập nhật Checklist & Bình luận',
  create_erp_event: 'Đặt lịch hẹn ERP',
  update_erp_event: 'Cập nhật lịch hẹn ERP',
  create_erp_note: 'Lưu ghi chú ERP',
  update_erp_note: 'Cập nhật ghi chú / thư mục ERP',
  update_crm_contact: 'Cập nhật liên hệ CRM',
  add_crm_note: 'Lưu ghi chú CRM',
  manage_crm_tag_or_label: 'Tạo/gắn Nhãn & Tag CRM',
  save_crm_campaign: 'Lưu chiến dịch CRM',
  assign_conversation_label: 'Gắn nhãn hội thoại',
  send_chat_message: 'Gửi tin nhắn chat',
};

function parseIsoMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : undefined;
}

function fmtIso(ms?: number | null): string | null {
  if (!ms || !Number.isFinite(Number(ms))) return null;
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return null;
  }
}

function fmtDateYmd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolvePeriodRange(period?: string, fromIso?: string, toIso?: string): { fromMs: number; toMs: number; label: string } {
  const now = Date.now();
  const d = new Date(now);
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const endOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();

  switch (period) {
    case 'today':
      return { fromMs: startOfToday, toMs: endOfToday, label: 'Hôm nay' };
    case 'yesterday':
      return { fromMs: startOfToday - 86_400_000, toMs: startOfToday - 1, label: 'Hôm qua' };
    case '30d':
      return { fromMs: startOfToday - 29 * 86_400_000, toMs: endOfToday, label: '30 ngày gần nhất' };
    case 'this_month': {
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
      return { fromMs: monthStart, toMs: endOfToday, label: `Tháng ${d.getMonth() + 1}/${d.getFullYear()}` };
    }
    case 'custom': {
      const f = parseIsoMs(fromIso) ?? (startOfToday - 6 * 86_400_000);
      const t = parseIsoMs(toIso) ?? endOfToday;
      return { fromMs: Math.min(f, t), toMs: Math.max(f, t), label: `${fmtDateYmd(Math.min(f, t))} → ${fmtDateYmd(Math.max(f, t))}` };
    }
    case '7d':
    default:
      return { fromMs: startOfToday - 6 * 86_400_000, toMs: endOfToday, label: '7 ngày gần nhất' };
  }
}

function getAllEmployeesMerged(db: DatabaseService): Array<{
  employeeId: string;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  departmentId: number | null;
  positionId: number | null;
  managerEmployeeId: string;
  erpRole: string;
  phone: string;
  email: string;
  address: string;
}> {
  const empRows = db.query<any>(
    `SELECT e.employee_id, e.username, e.display_name, e.role, e.is_active,
            p.department_id, p.position_id, p.manager_employee_id, p.erp_role,
            p.phone, p.email, p.address
     FROM employees e
     LEFT JOIN erp_employee_profiles p ON p.employee_id = e.employee_id
     ORDER BY e.display_name ASC`,
  );
  const seen = new Set<string>();
  const out = empRows.map(r => {
    const id = String(r.employee_id);
    seen.add(id);
    return {
      employeeId: id,
      username: String(r.username || ''),
      displayName: String(r.display_name || r.username || id),
      role: String(r.role || 'employee'),
      isActive: r.is_active !== 0,
      departmentId: r.department_id != null ? Number(r.department_id) : null,
      positionId: r.position_id != null ? Number(r.position_id) : null,
      managerEmployeeId: String(r.manager_employee_id || ''),
      erpRole: String(r.erp_role || 'member'),
      phone: String(r.phone || ''),
      email: String(r.email || ''),
      address: String(r.address || ''),
    };
  });

  const orphanProfiles = db.query<any>(`SELECT * FROM erp_employee_profiles`);
  for (const p of orphanProfiles) {
    const id = String(p.employee_id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      employeeId: id,
      username: id,
      displayName: id === 'boss' ? 'Chủ sở hữu (Boss)' : id,
      role: id === 'boss' ? 'boss' : 'employee',
      isActive: true,
      departmentId: p.department_id != null ? Number(p.department_id) : null,
      positionId: p.position_id != null ? Number(p.position_id) : null,
      managerEmployeeId: String(p.manager_employee_id || ''),
      erpRole: String(p.erp_role || (id === 'boss' ? 'owner' : 'member')),
      phone: String(p.phone || ''),
      email: String(p.email || ''),
      address: String(p.address || ''),
    });
  }
  return out;
}

function resolveEmployeeId(db: DatabaseService, idOrName?: string): string {
  const raw = String(idOrName || '').trim();
  if (!raw) return '';
  const all = getAllEmployeesMerged(db);
  const exact = all.find(e => e.employeeId === raw || e.username.toLowerCase() === raw.toLowerCase());
  if (exact) return exact.employeeId;
  const lower = raw.toLowerCase();
  const byName = all.find(e => e.displayName.toLowerCase() === lower) || all.find(e => e.displayName.toLowerCase().includes(lower));
  return byName ? byName.employeeId : raw;
}

function resolveLabelsByName(db: DatabaseService, labelName: string): {
  localLabelIds: number[];
  crmTagIds: number[];
  zaloLabelKeys: string[];
  zaloMatchedLabels: Array<{ accountId: string; id: number; text: string; conversations: string[] }>;
} {
  const needle = String(labelName || '').trim().toLowerCase();
  if (!needle) return { localLabelIds: [], crmTagIds: [], zaloLabelKeys: [], zaloMatchedLabels: [] };

  const q = `%${needle}%`;
  const localLabelIds = db
    .query<any>(`SELECT id FROM local_labels WHERE COALESCE(is_active, 1) = 1 AND LOWER(name) LIKE ?`, [q])
    .map((r) => Number(r.id))
    .filter(Number.isFinite);
  const crmTagIds = db
    .query<any>(`SELECT id FROM crm_tags WHERE LOWER(name) LIKE ?`, [q])
    .map((r) => Number(r.id))
    .filter(Number.isFinite);

  const zaloLabelKeys: string[] = [];
  const zaloMatchedLabels: Array<{ accountId: string; id: number; text: string; conversations: string[] }> = [];
  for (const acc of db.getAccounts()) {
    const cached = db.getZaloLabelsCache(acc.zalo_id);
    if (!cached) continue;
    for (const lbl of cached) {
      if (lbl.text.toLowerCase().includes(needle)) {
        zaloLabelKeys.push(`${acc.zalo_id}:${lbl.id}`);
        zaloMatchedLabels.push({ accountId: acc.zalo_id, id: lbl.id, text: lbl.text, conversations: lbl.conversations });
      }
    }
  }
  return { localLabelIds, crmTagIds, zaloLabelKeys, zaloMatchedLabels };
}

function zaloLabelNamesForThread(db: DatabaseService, accountId: string, threadId: string): string[] {
  const cached = db.getZaloLabelsCache(accountId);
  if (!cached) return [];
  return cached.filter((l) => l.conversations.includes(String(threadId))).map((l) => l.text);
}

class AIToolService {
  /**
   * Return allowed tool definitions for the assistant's permission config.
   * When permissions is omitted, defaults to DEFAULT_AI_TOOL_PERMISSIONS.
   */
  public static getToolDefinitions(permissions?: AIToolPermissions | null): AIToolDefinition[] {
    if (!permissions) return [...ALL_TOOLS];
    return ALL_TOOLS.filter(t => this.canExecuteTool(t.name, permissions).allowed);
  }

  public static canExecuteTool(
    toolName: string,
    permissions?: AIToolPermissions | null,
  ): { allowed: boolean; reason?: string } {
    const name = String(toolName || '').trim();
    if (!name || DESTRUCTIVE_TOOL_REGEX.test(name)) {
      return {
        allowed: false,
        reason: 'Bị chặn bởi chính sách bảo vệ dữ liệu: trợ lý AI không bao giờ được phép XÓA dữ liệu.',
      };
    }
    const def = TOOL_MAP.get(name);
    if (!def) {
      return { allowed: false, reason: `Công cụ không tồn tại hoặc không được phép: ${name}` };
    }
    if (!permissions) return { allowed: true };
    const perms = normalizeAIToolPermissions(permissions);
    const mod = def.module || 'messaging';
    const level = perms[mod];
    if (level === 'off') {
      return { allowed: false, reason: `Trợ lý AI chưa được cấp quyền truy cập phân hệ "${mod}".` };
    }
    if (def.kind === 'write' && level !== 'write') {
      return { allowed: false, reason: `Trợ lý AI chỉ có quyền Chỉ đọc ở phân hệ "${mod}", không được phép Tạo hoặc Sửa.` };
    }
    return { allowed: true };
  }

  public static isWriteTool(name: string): boolean {
    return WRITE_TOOL_NAMES.has(name);
  }

  public static getToolLabel(name: string): string {
    return TOOL_LABELS[name] || name;
  }

  public static buildPendingAction(call: AIToolCall, assistantId?: string): AIPendingToolAction {
    const args = call.arguments || {};
    let title = this.getToolLabel(call.name);
    let description = '';

    switch (call.name) {
      case 'manage_departments': {
        const items = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
        title = items.length > 1
          ? `Tạo/cập nhật ${items.length} phòng ban`
          : `${args.id ? 'Cập nhật' : 'Tạo'} phòng ban: ${items[0]?.name || ''}`;
        description = items.map((d: any) => `${d.id ? '[Sửa] ' : '+ '}${d.name}${d.description ? ` (${String(d.description).slice(0, 50)})` : ''}`).join('\n');
        break;
      }
      case 'manage_positions': {
        const items = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
        title = items.length > 1
          ? `Tạo/cập nhật ${items.length} chức vụ`
          : `${args.id ? 'Cập nhật' : 'Tạo'} chức vụ: ${items[0]?.name || ''}`;
        description = items.map((p: any) => `${p.id ? '[Sửa] ' : '+ '}${p.name}${p.departmentName ? ` · ${p.departmentName}` : ''}${p.level != null ? ` (Lv.${p.level})` : ''}`).join('\n');
        break;
      }
      case 'update_employee_profile': {
        const items = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
        title = items.length > 1
          ? `Cập nhật hồ sơ ${items.length} nhân sự`
          : `Cập nhật hồ sơ: ${items[0]?.employeeName || items[0]?.employeeId || ''}`;
        description = items.map((e: any) => [
          e.employeeName || e.employeeId || '?',
          e.departmentName || (e.departmentId ? `PB #${e.departmentId}` : ''),
          e.positionName || (e.positionId ? `CV #${e.positionId}` : ''),
          e.erpRole ? `Role: ${e.erpRole}` : '',
        ].filter(Boolean).join(' · ')).join('\n');
        break;
      }
      case 'record_hrm_leave_or_attendance':
        title = args.action === 'decide_leave'
          ? `${args.leaveDecision === 'approved' ? 'Duyệt' : 'Từ chối'} đơn nghỉ #${args.leaveId || ''}`
          : args.action === 'create_leave'
            ? `Tạo đơn nghỉ phép (${args.startDate || ''} → ${args.endDate || ''})`
            : args.action === 'check_in'
              ? `Check-in chấm công (${args.employeeId || 'boss'})`
              : `Check-out chấm công (${args.employeeId || 'boss'})`;
        description = [args.reason, args.note].filter(Boolean).join(' · ');
        break;
      case 'manage_erp_project':
        title = `${args.projectId ? 'Cập nhật' : 'Tạo'} dự án: ${args.name || ''}`;
        description = [args.departmentName || '', args.description || ''].filter(Boolean).join(' · ').slice(0, 160);
        break;
      case 'create_erp_task': {
        const items = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
        title = items.length > 1
          ? `Tạo ${items.length} công việc ERP`
          : `Tạo công việc: ${items[0]?.title || ''}`;
        description = items.map((t: any) => [
          `• ${t.title || ''}`,
          t.priority ? `[${t.priority}]` : '',
          t.dueDateIso ? `Hạn ${t.dueDateIso}` : '',
          t.checklistItems?.length ? `${t.checklistItems.length} checklist` : '',
        ].filter(Boolean).join(' ')).join('\n');
        break;
      }
      case 'update_erp_task':
        title = `Cập nhật công việc #${String(args.taskId || '').slice(0, 8)}`;
        description = [
          args.title ? `Tên: ${args.title}` : '',
          args.status ? `Trạng thái: ${args.status}` : '',
          args.priority ? `Ưu tiên: ${args.priority}` : '',
          args.dueDateIso ? `Hạn: ${args.dueDateIso}` : '',
          args.assigneeIds?.length ? `Giao: ${args.assigneeIds.length} người` : '',
        ].filter(Boolean).join(' · ');
        break;
      case 'manage_task_checklist_and_comments':
        title = `Cập nhật checklist / bình luận Task`;
        description = [
          args.addChecklistItems?.length ? `+${args.addChecklistItems.length} checklist` : '',
          args.toggleChecklistItems?.length ? `Đánh dấu ${args.toggleChecklistItems.length} mục` : '',
          args.commentContent ? `Bình luận: "${String(args.commentContent).slice(0, 80)}"` : '',
        ].filter(Boolean).join(' · ');
        break;
      case 'create_erp_event':
        title = `Đặt lịch: ${args.title || ''}`;
        description = [args.startAtIso ? `Bắt đầu: ${args.startAtIso}` : '', args.type ? `Loại: ${args.type}` : '', args.location || '', args.description || '']
          .filter(Boolean).join(' · ');
        break;
      case 'update_erp_event':
        title = `Cập nhật lịch hẹn${args.title ? `: ${args.title}` : ''}`;
        description = [args.startAtIso ? `Thời gian: ${args.startAtIso}` : '', args.location || ''].filter(Boolean).join(' · ');
        break;
      case 'create_erp_note':
        title = `Lưu ghi chú ERP: ${args.title || ''}`;
        description = [args.folderName ? `Thư mục: ${args.folderName}` : '', String(args.content || '').slice(0, 120)].filter(Boolean).join(' · ');
        break;
      case 'update_erp_note':
        title = args.createFolderName
          ? `Tạo thư mục ghi chú: ${args.createFolderName}`
          : args.renameFolderId
            ? `Đổi tên thư mục → ${args.newFolderName || ''}`
            : `Cập nhật ghi chú ERP${args.title ? `: ${args.title}` : ''}`;
        description = String(args.content || '').slice(0, 140);
        break;
      case 'update_crm_contact':
        title = `Cập nhật CRM: ${args.contactName || args.contactId || ''}`;
        description = [
          args.alias ? `Biệt danh: ${args.alias}` : '',
          args.phone ? `SĐT: ${args.phone}` : '',
          args.birthday ? `Sinh nhật: ${args.birthday}` : '',
        ].filter(Boolean).join(' · ');
        break;
      case 'add_crm_note':
        title = `${args.noteId ? 'Sửa' : 'Thêm'} ghi chú CRM cho ${args.contactName || args.contactId || ''}`;
        description = String(args.content || '').slice(0, 160);
        break;
      case 'manage_crm_tag_or_label':
        title = `${args.id ? 'Sửa' : 'Tạo'} ${args.targetType === 'crm_tag' ? 'Tag CRM' : 'Nhãn Deplao'}: "${args.name || ''}"`;
        description = args.assignContactIds?.length
          ? `Gắn cho ${args.assignContactIds.length} khách hàng/hội thoại`
          : `Màu: ${args.color || '#3B82F6'}`;
        break;
      case 'save_crm_campaign':
        title = `${args.campaignId ? 'Cập nhật' : 'Tạo'} chiến dịch CRM: "${args.name || ''}"`;
        description = [
          `Trạng thái: ${args.status === 'paused' ? 'Tạm dừng' : 'Bản nháp'}`,
          args.addContacts?.length ? `+${args.addContacts.length} khách hàng` : '',
          args.templateMessage ? String(args.templateMessage).slice(0, 80) : '',
        ].filter(Boolean).join(' · ');
        break;
      case 'assign_conversation_label':
        title = `Gắn nhãn "${args.labelName || ''}"`;
        description = `Hội thoại: ${args.threadName || args.threadId || ''}`;
        break;
      case 'send_chat_message':
        title = `Gửi tin tới ${args.threadName || args.threadId || ''} (${String(args.channel || '').toUpperCase()})`;
        description = String(args.message || '').slice(0, 180);
        break;
      default:
        description = JSON.stringify(args).slice(0, 150);
    }

    return {
      id: call.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      toolName: call.name,
      title,
      description,
      args,
      status: 'pending',
      clientSideExecution: call.name === 'send_chat_message',
      assistantId,
    };
  }

  public static async executeReadTool(
    name: string,
    rawArgs: any,
    permissions?: AIToolPermissions | null,
  ): Promise<{ summary: string; data: any }> {
    const permCheck = this.canExecuteTool(name, permissions);
    if (!permCheck.allowed) {
      return { summary: permCheck.reason || 'Không có quyền thực hiện', data: { error: permCheck.reason } };
    }

    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const db = DatabaseService.getInstance();

    try {
      switch (name) {
        case 'query_messages': {
          const filter: AIContextFilter = {
            timePreset: args.timePreset || (args.fromIso || args.toIso ? 'custom' : 'all'),
            fromTs: parseIsoMs(args.fromIso) ?? null,
            toTs: parseIsoMs(args.toIso) ?? null,
            threadType: args.threadType || 'all',
            channels: args.channel ? [String(args.channel)] : undefined,
            keyword: args.keyword ? String(args.keyword) : undefined,
            limit: Math.min(200, Math.max(1, Number(args.limit) || 50)),
          };

          if (args.labelName) {
            const resolved = resolveLabelsByName(db, String(args.labelName));
            if (!resolved.localLabelIds.length && !resolved.crmTagIds.length && !resolved.zaloLabelKeys.length) {
              return {
                summary: `Không tìm thấy nhãn Deplao hoặc nhãn Zalo nào khớp "${args.labelName}".`,
                data: { count: 0, threadCount: 0, messagesText: '' },
              };
            }
            filter.localLabelIds = resolved.localLabelIds;
            filter.crmTagIds = resolved.crmTagIds;
            filter.zaloLabelKeys = resolved.zaloLabelKeys;
            filter.labelMatchMode = 'any';
          }

          if (args.threadSearch) {
            const q = `%${String(args.threadSearch).trim()}%`;
            const matched = db.query<any>(
              `SELECT owner_zalo_id, contact_id FROM contacts
               WHERE display_name LIKE ? OR alias LIKE ? OR phone LIKE ? OR contact_id = ?
               ORDER BY last_message_time DESC LIMIT 20`,
              [q, q, q, String(args.threadSearch).trim()]
            );
            if (!matched.length) {
              return {
                summary: `Không tìm thấy hội thoại khớp "${args.threadSearch}".`,
                data: { count: 0, threadCount: 0, messagesText: '' },
              };
            }
            filter.threadKeys = matched.map(r => ({ accountId: r.owner_zalo_id, threadId: r.contact_id }));
          }

          const res = db.queryMessagesForAIContext(filter);
          return {
            summary: `Đã đọc ${res.count} tin nhắn từ ${res.threadCount} hội thoại`,
            data: { count: res.count, threadCount: res.threadCount, messagesText: res.formattedContext },
          };
        }

        case 'list_conversations': {
          const where: string[] = ['1=1'];
          const params: any[] = [];
          if (args.search) {
            const q = `%${String(args.search).trim()}%`;
            where.push(`(c.display_name LIKE ? OR c.alias LIKE ? OR c.phone LIKE ?)`);
            params.push(q, q, q);
          }
          if (args.channel) {
            where.push(`COALESCE(NULLIF(c.channel, ''), 'zalo') = ?`);
            params.push(String(args.channel));
          }
          if (args.threadType === 'direct') {
            where.push(`COALESCE(NULLIF(c.contact_type, ''), 'user') = 'user'`);
          } else if (args.threadType === 'group') {
            where.push(`c.contact_type IN ('group', 'channel')`);
          }
          if (args.unreadOnly) {
            where.push(`COALESCE(c.unread_count, 0) > 0`);
          }
          if (args.labelName) {
            const resolved = resolveLabelsByName(db, String(args.labelName));
            const orParts: string[] = [];
            if (resolved.localLabelIds.length) {
              orParts.push(`EXISTS (SELECT 1 FROM local_label_threads llt WHERE llt.owner_zalo_id = c.owner_zalo_id AND llt.thread_id = c.contact_id AND llt.label_id IN (${resolved.localLabelIds.map(() => '?').join(',')}))`);
              params.push(...resolved.localLabelIds);
            }
            if (resolved.crmTagIds.length) {
              orParts.push(`EXISTS (SELECT 1 FROM crm_contact_tags cct WHERE cct.owner_zalo_id = c.owner_zalo_id AND cct.contact_id = c.contact_id AND cct.tag_id IN (${resolved.crmTagIds.map(() => '?').join(',')}))`);
              params.push(...resolved.crmTagIds);
            }
            const byAcc = new Map<string, Set<string>>();
            for (const zl of resolved.zaloMatchedLabels) {
              if (!zl.conversations.length) continue;
              let s = byAcc.get(zl.accountId);
              if (!s) { s = new Set<string>(); byAcc.set(zl.accountId, s); }
              for (const cid of zl.conversations) s.add(cid);
            }
            for (const [accId, convs] of byAcc.entries()) {
              const arr = Array.from(convs);
              orParts.push(`(c.owner_zalo_id = ? AND c.contact_id IN (${arr.map(() => '?').join(',')}))`);
              params.push(accId, ...arr);
            }
            if (!orParts.length) {
              return { summary: `Không tìm thấy nhãn hoặc hội thoại nào khớp nhãn "${args.labelName}".`, data: [] };
            }
            where.push(`(${orParts.join(' OR ')})`);
          }
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
          const rows = db.query<any>(
            `SELECT c.owner_zalo_id AS accountId, c.contact_id AS threadId,
                    COALESCE(NULLIF(c.alias, ''), NULLIF(c.display_name, ''), c.contact_id) AS name,
                    COALESCE(NULLIF(c.channel, ''), 'zalo') AS channel,
                    COALESCE(NULLIF(c.contact_type, ''), 'user') AS contactType,
                    c.phone, COALESCE(c.unread_count, 0) AS unreadCount,
                    c.last_message AS lastMessage, c.last_message_time AS lastMessageTime
             FROM contacts c
             WHERE ${where.join(' AND ')}
             ORDER BY c.last_message_time DESC
             LIMIT ?`,
            [...params, limit]
          ).map((r: any) => ({
            ...r,
            zaloLabels: zaloLabelNamesForThread(db, r.accountId, r.threadId),
          }));
          return {
            summary: `Tìm thấy ${rows.length} hội thoại`,
            data: rows,
          };
        }

        case 'lookup_crm_contacts': {
          const where: string[] = ['1=1'];
          const params: any[] = [];
          if (args.query) {
            const q = `%${String(args.query).trim()}%`;
            where.push(`(c.display_name LIKE ? OR c.alias LIKE ? OR c.phone LIKE ? OR c.contact_id = ?)`);
            params.push(q, q, q, String(args.query).trim());
          }
          if (args.accountId) {
            where.push(`c.owner_zalo_id = ?`);
            params.push(String(args.accountId));
          }
          if (args.contactType === 'user') {
            where.push(`COALESCE(NULLIF(c.contact_type, ''), 'user') = 'user'`);
          } else if (args.contactType === 'group') {
            where.push(`c.contact_type IN ('group', 'channel')`);
          }
          if (args.labelName) {
            const resolved = resolveLabelsByName(db, String(args.labelName));
            const orParts: string[] = [];
            if (resolved.localLabelIds.length) {
              orParts.push(`EXISTS (SELECT 1 FROM local_label_threads llt WHERE llt.owner_zalo_id = c.owner_zalo_id AND llt.thread_id = c.contact_id AND llt.label_id IN (${resolved.localLabelIds.map(() => '?').join(',')}))`);
              params.push(...resolved.localLabelIds);
            }
            if (resolved.crmTagIds.length) {
              orParts.push(`EXISTS (SELECT 1 FROM crm_contact_tags cct WHERE cct.owner_zalo_id = c.owner_zalo_id AND cct.contact_id = c.contact_id AND cct.tag_id IN (${resolved.crmTagIds.map(() => '?').join(',')}))`);
              params.push(...resolved.crmTagIds);
            }
            const byAcc = new Map<string, Set<string>>();
            for (const zl of resolved.zaloMatchedLabels) {
              if (!zl.conversations.length) continue;
              let s = byAcc.get(zl.accountId);
              if (!s) { s = new Set<string>(); byAcc.set(zl.accountId, s); }
              for (const cid of zl.conversations) s.add(cid);
            }
            for (const [accId, convs] of byAcc.entries()) {
              const arr = Array.from(convs);
              orParts.push(`(c.owner_zalo_id = ? AND c.contact_id IN (${arr.map(() => '?').join(',')}))`);
              params.push(accId, ...arr);
            }
            if (!orParts.length) {
              return { summary: `Không tìm thấy nhãn nào khớp "${args.labelName}".`, data: [] };
            }
            where.push(`(${orParts.join(' OR ')})`);
          }

          const limit = Math.min(40, Math.max(1, Number(args.limit) || 15));
          const rows = db.query<any>(
            `SELECT c.owner_zalo_id AS accountId, c.contact_id AS contactId,
                    c.display_name AS displayName, c.alias,
                    COALESCE(NULLIF(c.alias, ''), NULLIF(c.display_name, ''), c.contact_id) AS name,
                    c.phone, c.gender, c.birthday,
                    COALESCE(NULLIF(c.channel, ''), 'zalo') AS channel,
                    COALESCE(NULLIF(c.contact_type, ''), 'user') AS contactType
             FROM contacts c
             WHERE ${where.join(' AND ')}
             ORDER BY c.last_message_time DESC
             LIMIT ?`,
            [...params, limit]
          );

          const enriched = rows.map((r: any) => {
            const labels = db.query<any>(
              `SELECT ll.id, ll.name FROM local_label_threads llt JOIN local_labels ll ON ll.id = llt.label_id
               WHERE llt.owner_zalo_id = ? AND llt.thread_id = ?`,
              [r.accountId, r.contactId]
            ).map(l => l.name);
            const crmTags = db.query<any>(
              `SELECT ct.id, ct.name FROM crm_contact_tags cct JOIN crm_tags ct ON ct.id = cct.tag_id
               WHERE cct.owner_zalo_id = ? AND cct.contact_id = ?`,
              [r.accountId, r.contactId]
            ).map(t => t.name);
            const zaloLabels = zaloLabelNamesForThread(db, r.accountId, r.contactId);
            const notes = db.query<any>(
              `SELECT id, content, updated_at FROM crm_notes WHERE owner_zalo_id = ? AND contact_id = ? ORDER BY updated_at DESC LIMIT 5`,
              [r.accountId, r.contactId]
            );
            return { ...r, labels, crmTags, zaloLabels, notes };
          });
          return {
            summary: `Tra cứu được ${enriched.length} liên hệ CRM`,
            data: enriched,
          };
        }

        case 'list_crm_tags_and_campaigns': {
          const include = args.include || 'all';
          const out: Record<string, any> = {};
          const accIdFilter = args.accountId ? String(args.accountId) : '';
          const accounts = db.getAccounts();

          if (include === 'all' || include === 'tags') {
            out.localLabels = db.getLocalLabels(accIdFilter || undefined).map((l: any) => ({
              id: l.id, name: l.name, color: l.color, emoji: l.emoji, isActive: l.is_active !== 0,
            }));
            out.crmTags = accIdFilter
              ? db.query<any>(`SELECT id, owner_zalo_id AS accountId, name, color, emoji FROM crm_tags WHERE owner_zalo_id = ? ORDER BY name ASC`, [accIdFilter])
              : db.query<any>(`SELECT id, owner_zalo_id AS accountId, name, color, emoji FROM crm_tags ORDER BY name ASC`);
            const zaloLabels: any[] = [];
            for (const acc of accounts) {
              if (accIdFilter && acc.zalo_id !== accIdFilter) continue;
              const cached = db.getZaloLabelsCache(acc.zalo_id) || [];
              for (const zl of cached) {
                zaloLabels.push({ accountId: acc.zalo_id, id: zl.id, text: zl.text, color: zl.color, threadCount: zl.conversations.length });
              }
            }
            out.zaloLabels = zaloLabels;
          }

          if (include === 'all' || include === 'campaigns') {
            const targetAccounts = accIdFilter ? [accIdFilter] : accounts.map(a => a.zalo_id);
            const campaigns: any[] = [];
            for (const accId of targetAccounts) {
              for (const c of db.getCRMCampaigns(accId)) {
                campaigns.push({
                  id: c.id,
                  accountId: c.owner_zalo_id,
                  channel: c.channel || 'zalo',
                  name: c.name,
                  campaignType: c.campaign_type || 'message',
                  status: c.status,
                  totalContacts: c.total_contacts ?? 0,
                  sentCount: c.sent_count ?? 0,
                  pendingCount: c.pending_count ?? 0,
                  failedCount: c.failed_count ?? 0,
                  sentTodayCount: c.sent_today_count ?? 0,
                  dailySendLimit: c.daily_send_limit ?? 0,
                  templatePreview: String(c.template_message || '').slice(0, 150),
                });
              }
            }
            out.campaigns = campaigns;
          }

          return {
            summary: `CRM: ${(out.localLabels?.length ?? 0) + (out.crmTags?.length ?? 0)} nhãn/tag, ${out.campaigns?.length ?? 0} chiến dịch`,
            data: out,
          };
        }

        case 'list_org_structure': {
          const include = args.include || 'all';
          const hrm = ErpEmployeeService.getInstance();
          const allDepts = hrm.listDepartments();
          const allPos = hrm.listPositions();
          const allEmps = getAllEmployeesMerged(db);

          const deptMap = new Map<number, string>(allDepts.map(d => [d.id, d.name]));
          const posMap = new Map<number, string>(allPos.map(p => [p.id, p.name]));
          const empNameMap = new Map<string, string>(allEmps.map(e => [e.employeeId, e.displayName]));

          const kw = args.search ? String(args.search).trim().toLowerCase() : '';
          const deptIdFilter = args.departmentId != null ? Number(args.departmentId) : null;

          const out: Record<string, any> = {};
          if (include === 'all' || include === 'departments') {
            out.departments = allDepts
              .filter(d => !kw || d.name.toLowerCase().includes(kw) || String(d.description || '').toLowerCase().includes(kw))
              .map(d => ({
                id: d.id,
                name: d.name,
                parentId: d.parent_id ?? null,
                parentName: d.parent_id ? deptMap.get(d.parent_id) || null : null,
                managerEmployeeId: d.manager_employee_id || null,
                managerName: d.manager_employee_id ? empNameMap.get(d.manager_employee_id) || d.manager_employee_id : null,
                description: d.description || '',
                employeeCount: d.employeeCount ?? 0,
              }));
          }
          if (include === 'all' || include === 'positions') {
            out.positions = allPos
              .filter(p => (deptIdFilter === null || p.department_id === deptIdFilter) && (!kw || p.name.toLowerCase().includes(kw)))
              .map(p => ({
                id: p.id,
                name: p.name,
                level: p.level,
                departmentId: p.department_id ?? null,
                departmentName: p.department_id ? deptMap.get(p.department_id) || null : null,
              }));
          }
          if (include === 'all' || include === 'employees') {
            out.employees = allEmps
              .filter(e =>
                (deptIdFilter === null || e.departmentId === deptIdFilter) &&
                (!kw || e.displayName.toLowerCase().includes(kw) || e.username.toLowerCase().includes(kw) || e.email.toLowerCase().includes(kw))
              )
              .map(e => ({
                ...e,
                departmentName: e.departmentId ? deptMap.get(e.departmentId) || null : null,
                positionName: e.positionId ? posMap.get(e.positionId) || null : null,
                managerName: e.managerEmployeeId ? empNameMap.get(e.managerEmployeeId) || e.managerEmployeeId : null,
              }));
          }

          return {
            summary: `Tổ chức: ${allDepts.length} phòng ban, ${allPos.length} chức vụ, ${allEmps.length} nhân sự`,
            data: out,
          };
        }

        case 'list_hrm_records': {
          const kind = args.kind || 'all';
          const hrm = ErpEmployeeService.getInstance();
          const allEmps = getAllEmployeesMerged(db);
          const empNameMap = new Map<string, string>(allEmps.map(e => [e.employeeId, e.displayName]));
          const out: Record<string, any> = {};

          if (kind === 'all' || kind === 'attendance') {
            const rows = hrm.listAttendance({
              employeeId: args.employeeId ? String(args.employeeId) : undefined,
              from: args.fromDate ? String(args.fromDate) : undefined,
              to: args.toDate ? String(args.toDate) : undefined,
            }).slice(0, 100);
            out.attendance = rows.map(a => ({
              ...a,
              employeeName: empNameMap.get(a.employee_id) || a.employee_id,
              checkInIso: fmtIso(a.check_in_at),
              checkOutIso: fmtIso(a.check_out_at),
            }));
          }

          if (kind === 'all' || kind === 'leaves') {
            let sql = `SELECT * FROM erp_leave_requests WHERE 1=1`;
            const params: any[] = [];
            if (args.employeeId) { sql += ` AND requester_id = ?`; params.push(String(args.employeeId)); }
            if (args.status) { sql += ` AND status = ?`; params.push(String(args.status)); }
            if (args.fromDate) { sql += ` AND end_date >= ?`; params.push(String(args.fromDate)); }
            if (args.toDate) { sql += ` AND start_date <= ?`; params.push(String(args.toDate)); }
            sql += ` ORDER BY created_at DESC LIMIT 60`;
            out.leaves = db.query<any>(sql, params).map(l => ({
              ...l,
              requesterName: empNameMap.get(l.requester_id) || l.requester_id,
              approverName: l.approver_id ? empNameMap.get(l.approver_id) || l.approver_id : null,
            }));
          }

          return {
            summary: `HRM: ${out.attendance?.length ?? 0} bản ghi chấm công, ${out.leaves?.length ?? 0} đơn nghỉ`,
            data: out,
          };
        }

        case 'list_projects_and_tasks': {
          const taskSvc = ErpTaskService.getInstance();
          const depts = ErpEmployeeService.getInstance().listDepartments();
          const deptMap = new Map<number, string>(depts.map(d => [d.id, d.name]));
          const allEmps = getAllEmployeesMerged(db);
          const empNameMap = new Map<string, string>(allEmps.map(e => [e.employeeId, e.displayName]));

          if (args.taskId) {
            const detail = taskSvc.getTaskDetail(String(args.taskId));
            if (!detail) return { summary: `Không tìm thấy công việc ID ${args.taskId}`, data: null };
            const proj = detail.project_id ? taskSvc.getProject(detail.project_id) : undefined;
            return {
              summary: `Chi tiết task "${detail.title}" (${detail.status})`,
              data: {
                ...detail,
                projectName: proj?.name || null,
                dueDateIso: fmtIso(detail.due_date),
                startDateIso: fmtIso(detail.start_date),
                assigneeNames: (detail.assignees || []).map(id => empNameMap.get(id) || id),
              },
            };
          }

          const allProjects = taskSvc.listProjects({ archived: false });
          const projMap = new Map(allProjects.map(p => [p.id, p]));
          let filteredProjects = allProjects;
          if (args.departmentId != null) {
            filteredProjects = filteredProjects.filter(p => p.department_id === Number(args.departmentId));
          }

          let tasks = taskSvc.listTasks({
            projectId: args.projectId ? String(args.projectId) : undefined,
            assigneeId: args.assigneeId ? String(args.assigneeId) : undefined,
            status: args.status || undefined,
            priority: args.priority || undefined,
            search: args.search ? String(args.search) : undefined,
            limit: Math.min(100, Math.max(1, Number(args.limit) || 40)),
          });

          if (args.departmentId != null) {
            const allowedProjIds = new Set(filteredProjects.map(p => p.id));
            tasks = tasks.filter(t => t.project_id && allowedProjIds.has(t.project_id));
          }

          const now = Date.now();
          const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
          const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
          const weekEnd = todayEnd.getTime() + 7 * 86_400_000;
          if (args.dueFilter === 'overdue') {
            tasks = tasks.filter(t => t.due_date && t.due_date < now && !['done', 'cancelled'].includes(t.status));
          } else if (args.dueFilter === 'today') {
            tasks = tasks.filter(t => t.due_date && t.due_date >= todayStart.getTime() && t.due_date <= todayEnd.getTime());
          } else if (args.dueFilter === 'this_week') {
            tasks = tasks.filter(t => t.due_date && t.due_date >= todayStart.getTime() && t.due_date <= weekEnd);
          } else if (args.dueFilter === 'upcoming') {
            tasks = tasks.filter(t => t.due_date && t.due_date >= now && !['done', 'cancelled'].includes(t.status));
          }

          const out: Record<string, any> = {};
          if (args.includeProjects !== false) {
            out.projects = filteredProjects.map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              departmentId: p.department_id ?? null,
              departmentName: p.department_id ? deptMap.get(p.department_id) || null : null,
              status: p.status,
            }));
          }
          out.tasks = tasks.map(t => {
            const proj = t.project_id ? projMap.get(t.project_id) : undefined;
            return {
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              projectId: t.project_id || null,
              projectName: proj?.name || null,
              dueDateIso: fmtIso(t.due_date),
              isOverdue: !!(t.due_date && t.due_date < now && !['done', 'cancelled'].includes(t.status)),
              checklistProgress: `${t.checklist_done || 0}/${t.checklist_total || 0}`,
              commentCount: t.comment_count || 0,
              estimatedHours: t.estimated_hours ?? null,
              actualHours: t.actual_hours ?? 0,
              assignees: (t.assignees || []).map(id => ({ employeeId: id, name: empNameMap.get(id) || id })),
            };
          });

          return {
            summary: `ERP: ${filteredProjects.length} dự án, ${out.tasks.length} công việc`,
            data: out,
          };
        }

        case 'list_calendar_and_notes': {
          const kind = args.kind || 'all';
          const out: Record<string, any> = {};
          const summaryParts: string[] = [];

          if (args.noteId) {
            const note = ErpNoteService.getInstance().getNote(String(args.noteId));
            return {
              summary: note ? `Ghi chú "${note.title}"` : `Không tìm thấy ghi chú ${args.noteId}`,
              data: note || null,
            };
          }

          if (kind === 'all' || kind === 'events') {
            const daysBack = Math.min(30, Math.max(0, Number(args.daysBack) || 3));
            const daysAhead = Math.min(90, Math.max(1, Number(args.daysAhead) || 14));
            const events = ErpCalendarService.getInstance().listEvents({
              from: Date.now() - daysBack * 86_400_000,
              to: Date.now() + daysAhead * 86_400_000,
              limit: 40,
            });
            out.events = events
              .filter(e => !args.search || `${e.title} ${e.description || ''}`.toLowerCase().includes(String(args.search).toLowerCase()))
              .map(e => ({
                id: e.id,
                title: e.title,
                type: e.type,
                location: e.location || '',
                startAtIso: fmtIso(e.start_at),
                endAtIso: fmtIso(e.end_at),
                description: e.description,
              }));
            summaryParts.push(`${out.events.length} lịch hẹn`);
          }

          if (kind === 'all' || kind === 'folders') {
            out.folders = db.query<any>(`SELECT * FROM erp_note_folders ORDER BY name ASC LIMIT 200`);
            summaryParts.push(`${out.folders.length} thư mục`);
          }

          if (kind === 'all' || kind === 'notes') {
            const notes = ErpNoteService.getInstance().listNotes({
              folderId: args.folderId != null ? Number(args.folderId) : undefined,
              search: args.search ? String(args.search) : undefined,
              limit: 25,
            });
            out.notes = notes.map(n => ({
              id: n.id,
              folderId: n.folder_id ?? null,
              title: n.title,
              pinned: !!n.pinned,
              contentPreview: String(n.content || '').slice(0, 350),
              updatedAtIso: fmtIso(n.updated_at),
            }));
            summaryParts.push(`${out.notes.length} ghi chú`);
          }

          return {
            summary: `Lịch & Ghi chú: ${summaryParts.join(', ')}`,
            data: out,
          };
        }

        case 'generate_work_report': {
          const { fromMs, toMs, label } = resolvePeriodRange(args.period, args.fromIso, args.toIso);
          const now = Date.now();
          const d = new Date(now);
          const todayStartMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
          const todayEndMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
          const next7dEndMs = todayEndMs + 7 * 86_400_000;

          const hrm = ErpEmployeeService.getInstance();
          const taskSvc = ErpTaskService.getInstance();
          const depts = hrm.listDepartments();
          const positions = hrm.listPositions();
          const allEmps = getAllEmployeesMerged(db);
          const projects = taskSvc.listProjects({ archived: false });

          const deptMap = new Map(depts.map(x => [x.id, x]));
          const posMap = new Map(positions.map(x => [x.id, x]));
          const projMap = new Map(projects.map(x => [x.id, x]));
          const empMap = new Map(allEmps.map(x => [x.employeeId, x]));

          let allTasks = taskSvc.listTasks({ limit: 500 });
          if (args.projectId) {
            allTasks = allTasks.filter(t => t.project_id === String(args.projectId));
          }
          if (args.departmentId != null) {
            const deptProjIds = new Set(projects.filter(p => p.department_id === Number(args.departmentId)).map(p => p.id));
            const deptEmpIds = new Set(allEmps.filter(e => e.departmentId === Number(args.departmentId)).map(e => e.employeeId));
            allTasks = allTasks.filter(t =>
              (t.project_id && deptProjIds.has(t.project_id)) ||
              (t.assignees || []).some(a => deptEmpIds.has(a))
            );
          }
          if (args.employeeId) {
            const eid = resolveEmployeeId(db, String(args.employeeId));
            allTasks = allTasks.filter(t => (t.assignees || []).includes(eid));
          }

          const byStatus = { todo: 0, doing: 0, review: 0, done: 0, cancelled: 0 };
          let createdInPeriod = 0;
          let completedInPeriod = 0;
          let overdueCount = 0;
          let dueTodayCount = 0;
          let dueNext7DaysCount = 0;
          let estHours = 0;
          let actHours = 0;
          const overdueTasks: any[] = [];
          const upcomingTasks: any[] = [];

          for (const t of allTasks) {
            if (t.status in byStatus) (byStatus as any)[t.status]++;
            if (t.created_at >= fromMs && t.created_at <= toMs) createdInPeriod++;
            if (t.status === 'done' && t.completed_at && t.completed_at >= fromMs && t.completed_at <= toMs) completedInPeriod++;
            if (t.estimated_hours) estHours += Number(t.estimated_hours);
            if (t.actual_hours) actHours += Number(t.actual_hours);

            const active = t.status !== 'done' && t.status !== 'cancelled';
            if (active && t.due_date) {
              if (t.due_date < now) {
                overdueCount++;
                if (overdueTasks.length < 15) {
                  overdueTasks.push({
                    id: t.id,
                    title: t.title,
                    priority: t.priority,
                    status: t.status,
                    dueDateIso: fmtIso(t.due_date),
                    projectName: t.project_id ? projMap.get(t.project_id)?.name || null : null,
                    assignees: (t.assignees || []).map(id => empMap.get(id)?.displayName || id),
                  });
                }
              } else {
                if (t.due_date >= todayStartMs && t.due_date <= todayEndMs) dueTodayCount++;
                if (t.due_date <= next7dEndMs) {
                  dueNext7DaysCount++;
                  if (upcomingTasks.length < 12) {
                    upcomingTasks.push({
                      id: t.id,
                      title: t.title,
                      priority: t.priority,
                      dueDateIso: fmtIso(t.due_date),
                      projectName: t.project_id ? projMap.get(t.project_id)?.name || null : null,
                      assignees: (t.assignees || []).map(id => empMap.get(id)?.displayName || id),
                    });
                  }
                }
              }
            }
          }

          const totalEffective = Math.max(1, allTasks.length - byStatus.cancelled);
          const completionRatePct = Math.round((byStatus.done / totalEffective) * 100);

          const byProject = projects.map(p => {
            const pTasks = allTasks.filter(t => t.project_id === p.id);
            const pDone = pTasks.filter(t => t.status === 'done').length;
            const pOverdue = pTasks.filter(t => t.due_date && t.due_date < now && !['done', 'cancelled'].includes(t.status)).length;
            return {
              id: p.id,
              name: p.name,
              departmentName: p.department_id ? deptMap.get(p.department_id)?.name || null : null,
              totalTasks: pTasks.length,
              done: pDone,
              doing: pTasks.filter(t => t.status === 'doing').length,
              todo: pTasks.filter(t => t.status === 'todo').length,
              overdue: pOverdue,
              completionRatePct: pTasks.length ? Math.round((pDone / pTasks.length) * 100) : 0,
            };
          });

          const byDepartment = depts.map(dep => {
            const deptProjIds = new Set(projects.filter(p => p.department_id === dep.id).map(p => p.id));
            const deptEmpIds = new Set(allEmps.filter(e => e.departmentId === dep.id).map(e => e.employeeId));
            const depTasks = allTasks.filter(t =>
              (t.project_id && deptProjIds.has(t.project_id)) ||
              (t.assignees || []).some(a => deptEmpIds.has(a))
            );
            const done = depTasks.filter(t => t.status === 'done').length;
            const overdue = depTasks.filter(t => t.due_date && t.due_date < now && !['done', 'cancelled'].includes(t.status)).length;
            return {
              id: dep.id,
              name: dep.name,
              employeeCount: deptEmpIds.size,
              projectCount: deptProjIds.size,
              totalTasks: depTasks.length,
              doneTasks: done,
              overdueTasks: overdue,
            };
          });

          const byEmployee = allEmps.map(e => {
            const empTasks = allTasks.filter(t => (t.assignees || []).includes(e.employeeId));
            return {
              employeeId: e.employeeId,
              name: e.displayName,
              departmentName: e.departmentId ? deptMap.get(e.departmentId)?.name || null : null,
              positionName: e.positionId ? posMap.get(e.positionId)?.name || null : null,
              assignedTotal: empTasks.length,
              todo: empTasks.filter(t => t.status === 'todo').length,
              doing: empTasks.filter(t => t.status === 'doing').length,
              review: empTasks.filter(t => t.status === 'review').length,
              done: empTasks.filter(t => t.status === 'done').length,
              completedInPeriod: empTasks.filter(t => t.status === 'done' && t.completed_at && t.completed_at >= fromMs && t.completed_at <= toMs).length,
              overdue: empTasks.filter(t => t.due_date && t.due_date < now && !['done', 'cancelled'].includes(t.status)).length,
            };
          });

          const fromYmd = fmtDateYmd(fromMs);
          const toYmd = fmtDateYmd(toMs);
          const attendanceRows = hrm.listAttendance({ from: fromYmd, to: toYmd });
          const pendingLeaves = db.query<any>(`SELECT * FROM erp_leave_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20`)
            .map(l => ({ ...l, requesterName: empMap.get(l.requester_id)?.displayName || l.requester_id }));
          const approvedLeavesCount = db.queryOne<any>(
            `SELECT COUNT(*) AS cnt FROM erp_leave_requests WHERE status = 'approved' AND end_date >= ? AND start_date <= ?`,
            [fromYmd, toYmd]
          )?.cnt ?? 0;

          const fromSec = Math.floor(fromMs / 1000);
          const toSec = Math.ceil(toMs / 1000);
          const msgStats = db.queryOne<any>(
            `SELECT
                COALESCE(SUM(CASE WHEN is_sent = 1 THEN 1 ELSE 0 END), 0) AS sentCount,
                COALESCE(SUM(CASE WHEN COALESCE(is_sent, 0) = 0 THEN 1 ELSE 0 END), 0) AS receivedCount,
                COUNT(DISTINCT owner_zalo_id || ':' || thread_id) AS activeThreads
             FROM messages
             WHERE (timestamp BETWEEN ? AND ?)
                OR (timestamp > 0 AND timestamp < 100000000000 AND timestamp BETWEEN ? AND ?)`,
            [fromMs, toMs, fromSec, toSec]
          );
          const unreadThreads = db.queryOne<any>(`SELECT COUNT(*) AS cnt FROM contacts WHERE COALESCE(unread_count, 0) > 0`)?.cnt ?? 0;
          const crmNotesInPeriod = db.queryOne<any>(`SELECT COUNT(*) AS cnt FROM crm_notes WHERE created_at BETWEEN ? AND ?`, [fromMs, toMs])?.cnt ?? 0;
          const campaignCounts = db.queryOne<any>(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) AS draft,
                COALESCE(SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END), 0) AS paused
             FROM crm_campaigns`
          );

          return {
            summary: `Báo cáo (${label}): ${allTasks.length} công việc (${completionRatePct}% hoàn thành), ${overdueCount} quá hạn, ${depts.length} phòng ban`,
            data: {
              period: { label, fromIso: fmtIso(fromMs), toIso: fmtIso(toMs) },
              taskSummary: {
                total: allTasks.length,
                ...byStatus,
                completionRatePct,
                createdInPeriod,
                completedInPeriod,
                overdueCount,
                dueTodayCount,
                dueNext7DaysCount,
                estimatedHoursTotal: Math.round(estHours * 10) / 10,
                actualHoursTotal: Math.round(actHours * 10) / 10,
                overdueTasks,
                upcomingTasks,
              },
              byProject,
              byDepartment,
              byEmployee,
              hrmSummary: {
                departmentCount: depts.length,
                positionCount: positions.length,
                employeeCount: allEmps.length,
                attendanceCheckInsInPeriod: attendanceRows.length,
                pendingLeaveRequests: pendingLeaves.length,
                approvedLeavesInPeriod: approvedLeavesCount,
                pendingLeavesList: pendingLeaves.slice(0, 10),
              },
              crmAndMessaging: {
                messagesSentInPeriod: msgStats?.sentCount ?? 0,
                messagesReceivedInPeriod: msgStats?.receivedCount ?? 0,
                activeThreadsInPeriod: msgStats?.activeThreads ?? 0,
                unreadThreadsNow: unreadThreads,
                crmNotesAddedInPeriod: crmNotesInPeriod,
                campaigns: campaignCounts || { total: 0, active: 0, draft: 0, paused: 0 },
              },
            },
          };
        }

        case 'lookup_pos': {
          const configs = IntegrationRegistry.listConfigs().filter(c => c.enabled && c.connectedAt);
          const posTypes = new Set(['kiotviet', 'haravan', 'sapo', 'nhanh', 'pancake']);
          const posConfigs = configs.filter(c => posTypes.has(c.type));
          if (!posConfigs.length) {
            return {
              summary: 'Chưa có tích hợp POS nào được kết nối.',
              data: { connected: false, integrations: configs.map(c => ({ id: c.id, type: c.type, name: c.name })) },
            };
          }
          const target = posConfigs[0];
          const action = String(args.action || 'lookupProduct');
          const res = await IntegrationRegistry.executeAction(target.id, action, {
            keyword: args.keyword || '',
            phone: args.phone || '',
            orderId: args.orderId || '',
            limit: 20,
          });
          return {
            summary: `Đã gọi ${target.name} (${action})`,
            data: { integration: target.name, type: target.type, result: res },
          };
        }

        default:
          return { summary: `Tool không hỗ trợ: ${name}`, data: { error: 'Unknown read tool' } };
      }
    } catch (err: any) {
      Logger.warn(`[AIToolService] executeReadTool(${name}) failed: ${err?.message || err}`);
      return { summary: `Lỗi tool ${name}: ${err?.message || err}`, data: { error: err?.message || String(err) } };
    }
  }

  public static async executeWriteTool(
    toolName: string,
    rawArgs: any,
    permissions?: AIToolPermissions | null,
  ): Promise<{ success: boolean; summary: string; data?: any; error?: string }> {
    const permCheck = this.canExecuteTool(toolName, permissions);
    if (!permCheck.allowed) {
      return {
        success: false,
        summary: permCheck.reason || 'Bị từ chối quyền thực thi',
        error: permCheck.reason || 'Permission denied',
      };
    }

    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const db = DatabaseService.getInstance();

    try {
      switch (toolName) {
        case 'manage_departments': {
          const hrm = ErpEmployeeService.getInstance();
          const rawItems: any[] = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
          const existingDepts = hrm.listDepartments();
          const nameToId = new Map<string, number>();
          for (const d of existingDepts) nameToId.set(d.name.trim().toLowerCase(), d.id);

          const results: any[] = [];
          for (const item of rawItems) {
            const deptName = String(item?.name || '').trim();
            if (!deptName && !item?.id) continue;

            let parentId = item.parentId != null ? Number(item.parentId) : undefined;
            if (parentId === undefined && item.parentName) {
              parentId = nameToId.get(String(item.parentName).trim().toLowerCase());
            }
            const managerId = item.managerEmployeeId
              ? resolveEmployeeId(db, String(item.managerEmployeeId))
              : undefined;

            const existingId = item.id ? Number(item.id) : nameToId.get(deptName.toLowerCase());
            if (existingId) {
              const updated = hrm.updateDepartment(existingId, {
                name: deptName || undefined,
                parent_id: parentId !== undefined ? parentId : undefined,
                manager_employee_id: managerId !== undefined ? managerId : undefined,
                description: item.description !== undefined ? String(item.description) : undefined,
              });
              nameToId.set(updated.name.trim().toLowerCase(), updated.id);
              results.push(updated);
            } else {
              const created = hrm.createDepartment({
                name: deptName,
                parent_id: parentId ?? null,
                manager_employee_id: managerId ?? '',
                description: item.description ? String(item.description) : '',
              });
              nameToId.set(created.name.trim().toLowerCase(), created.id);
              results.push(created);
            }
          }
          if (!results.length) {
            return { success: false, summary: 'Không có tên phòng ban hợp lệ để lưu', error: 'Missing department name' };
          }
          db.save();
          return {
            success: true,
            summary: results.length === 1
              ? `Đã lưu phòng ban "${results[0].name}"`
              : `Đã lưu ${results.length} phòng ban: ${results.map(r => r.name).join(', ')}`,
            data: results,
          };
        }

        case 'manage_positions': {
          const hrm = ErpEmployeeService.getInstance();
          const rawItems: any[] = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
          const depts = hrm.listDepartments();
          const deptNameToId = new Map<string, number>(depts.map(d => [d.name.trim().toLowerCase(), d.id]));
          const existingPos = hrm.listPositions();

          const results: any[] = [];
          for (const item of rawItems) {
            const posName = String(item?.name || '').trim();
            if (!posName && !item?.id) continue;

            let deptId: number | null | undefined = item.departmentId != null ? Number(item.departmentId) : undefined;
            if (deptId === undefined && item.departmentName) {
              deptId = deptNameToId.get(String(item.departmentName).trim().toLowerCase()) ?? null;
            }
            const level = item.level != null && Number.isFinite(Number(item.level)) ? Number(item.level) : undefined;

            const matched = item.id
              ? existingPos.find(p => p.id === Number(item.id))
              : existingPos.find(p => p.name.trim().toLowerCase() === posName.toLowerCase() && (deptId === undefined || p.department_id === deptId));

            if (matched) {
              const updated = hrm.updatePosition(matched.id, {
                name: posName || undefined,
                level: level !== undefined ? level : undefined,
                department_id: deptId !== undefined ? deptId : undefined,
              });
              results.push(updated);
            } else {
              const created = hrm.createPosition({
                name: posName,
                level: level ?? 1,
                department_id: deptId ?? null,
              });
              existingPos.push(created);
              results.push(created);
            }
          }
          if (!results.length) {
            return { success: false, summary: 'Không có tên chức vụ hợp lệ để lưu', error: 'Missing position name' };
          }
          db.save();
          return {
            success: true,
            summary: results.length === 1
              ? `Đã lưu chức vụ "${results[0].name}"`
              : `Đã lưu ${results.length} chức vụ: ${results.map(r => r.name).join(', ')}`,
            data: results,
          };
        }

        case 'update_employee_profile': {
          const hrm = ErpEmployeeService.getInstance();
          const rawItems: any[] = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
          const depts = hrm.listDepartments();
          const positions = hrm.listPositions();
          const deptNameToId = new Map(depts.map(d => [d.name.trim().toLowerCase(), d.id]));
          const posNameToId = new Map(positions.map(p => [p.name.trim().toLowerCase(), p.id]));

          const results: any[] = [];
          for (const item of rawItems) {
            const empId = resolveEmployeeId(db, item.employeeId || item.employeeName);
            if (!empId) continue;

            const patch: Record<string, any> = {};
            if (item.departmentId !== undefined) patch.department_id = item.departmentId;
            else if (item.departmentName) {
              const dId = deptNameToId.get(String(item.departmentName).trim().toLowerCase());
              if (dId !== undefined) patch.department_id = dId;
            }

            if (item.positionId !== undefined) patch.position_id = item.positionId;
            else if (item.positionName) {
              const pId = posNameToId.get(String(item.positionName).trim().toLowerCase());
              if (pId !== undefined) patch.position_id = pId;
            }

            if (item.managerEmployeeId !== undefined) {
              patch.manager_employee_id = resolveEmployeeId(db, String(item.managerEmployeeId));
            }
            if (item.erpRole && ['owner', 'admin', 'manager', 'member', 'guest'].includes(item.erpRole)) {
              patch.erp_role = item.erpRole;
            }
            if (item.phone !== undefined) patch.phone = String(item.phone);
            if (item.email !== undefined) patch.email = String(item.email);
            if (item.gender !== undefined) patch.gender = String(item.gender);
            if (item.address !== undefined) patch.address = String(item.address);

            const profile = hrm.upsertProfile(empId, patch);
            results.push(profile);
          }
          if (!results.length) {
            return { success: false, summary: 'Không tìm thấy nhân viên hợp lệ để cập nhật', error: 'Invalid employeeId' };
          }
          db.save();
          return {
            success: true,
            summary: `Đã cập nhật hồ sơ cho ${results.length} nhân sự`,
            data: results,
          };
        }

        case 'record_hrm_leave_or_attendance': {
          const hrm = ErpEmployeeService.getInstance();
          const action = String(args.action || '');
          const empId = resolveEmployeeId(db, args.employeeId || 'boss') || 'boss';

          if (action === 'check_in') {
            const row = hrm.checkIn(empId, args.note ? String(args.note) : '');
            db.save();
            return { success: true, summary: `Đã check-in cho ${empId}`, data: row };
          }
          if (action === 'check_out') {
            const row = hrm.checkOut(empId, args.note ? String(args.note) : '');
            db.save();
            return { success: true, summary: `Đã check-out cho ${empId}`, data: row };
          }
          if (action === 'create_leave') {
            if (!args.startDate || !args.endDate) {
              return { success: false, summary: 'Thiếu ngày bắt đầu hoặc ngày kết thúc nghỉ phép', error: 'Missing dates' };
            }
            const leave = hrm.createLeave({
              leave_type: ['annual', 'sick', 'unpaid', 'other'].includes(args.leaveType) ? args.leaveType : 'annual',
              start_date: String(args.startDate),
              end_date: String(args.endDate),
              days: args.days ? Number(args.days) : undefined,
              reason: args.reason ? String(args.reason) : '',
            }, empId);
            db.save();
            return { success: true, summary: `Đã tạo đơn nghỉ phép #${leave.id}`, data: leave };
          }
          if (action === 'decide_leave') {
            const leaveId = Number(args.leaveId);
            const decision = args.leaveDecision === 'rejected' ? 'rejected' : 'approved';
            if (!Number.isFinite(leaveId)) {
              return { success: false, summary: 'Thiếu leaveId hợp lệ', error: 'Missing leaveId' };
            }
            const leave = hrm.decideLeave(leaveId, decision, 'boss', args.note ? String(args.note) : '');
            db.save();
            return { success: true, summary: `Đã ${decision === 'approved' ? 'duyệt' : 'từ chối'} đơn nghỉ #${leaveId}`, data: leave };
          }
          return { success: false, summary: `Hành động HRM không hợp lệ: ${action}`, error: 'Invalid HRM action' };
        }

        case 'manage_erp_project': {
          const taskSvc = ErpTaskService.getInstance();
          const name = String(args.name || '').trim();
          if (!name && !args.projectId) {
            return { success: false, summary: 'Thiếu tên dự án', error: 'Missing project name' };
          }
          const depts = ErpEmployeeService.getInstance().listDepartments();
          const deptNameToId = new Map(depts.map(d => [d.name.trim().toLowerCase(), d.id]));
          let deptId = args.departmentId != null ? Number(args.departmentId) : undefined;
          if (deptId === undefined && args.departmentName) {
            deptId = deptNameToId.get(String(args.departmentName).trim().toLowerCase());
          }

          if (args.projectId) {
            const updated = taskSvc.updateProject(String(args.projectId), {
              name: name || undefined,
              description: args.description !== undefined ? String(args.description) : undefined,
              color: args.color ? String(args.color) : undefined,
              department_id: deptId !== undefined ? deptId : undefined,
            });
            db.save();
            return { success: true, summary: `Đã cập nhật dự án "${updated.name}"`, data: updated };
          } else {
            const created = taskSvc.createProject({
              name,
              description: args.description ? String(args.description) : '',
              color: args.color ? String(args.color) : '#3b82f6',
              department_id: deptId ?? null,
            }, 'boss');
            db.save();
            return { success: true, summary: `Đã tạo dự án "${created.name}"`, data: created };
          }
        }

        case 'create_erp_task': {
          const taskSvc = ErpTaskService.getInstance();
          const rawItems: any[] = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];
          const projects = taskSvc.listProjects({ archived: false });
          const projNameToId = new Map(projects.map(p => [p.name.trim().toLowerCase(), p.id]));

          const createdTasks: any[] = [];
          for (const item of rawItems) {
            const title = String(item?.title || '').trim();
            if (!title) continue;

            let projectId = item.projectId ? String(item.projectId) : undefined;
            if (!projectId && item.projectName) {
              projectId = projNameToId.get(String(item.projectName).trim().toLowerCase());
            }
            const assignees = Array.isArray(item.assigneeIds)
              ? item.assigneeIds.map((id: any) => resolveEmployeeId(db, String(id))).filter(Boolean)
              : undefined;
            const status = ['todo', 'doing', 'review', 'done'].includes(item.status) ? item.status : 'todo';

            const task = taskSvc.createTask({
              project_id: projectId,
              parent_task_id: item.parentTaskId ? String(item.parentTaskId) : undefined,
              title,
              description: item.description ? String(item.description) : '',
              status,
              priority: ['low', 'normal', 'high', 'urgent'].includes(item.priority) ? item.priority : 'normal',
              start_date: parseIsoMs(item.startDateIso),
              due_date: parseIsoMs(item.dueDateIso),
              estimated_hours: item.estimatedHours != null ? Number(item.estimatedHours) : undefined,
              assignees,
              linked_contact_id: item.linkedContactId ? String(item.linkedContactId) : undefined,
            }, 'boss');

            if (Array.isArray(item.checklistItems)) {
              for (const cl of item.checklistItems) {
                const clText = String(cl || '').trim();
                if (clText) taskSvc.addChecklist(task.id, clText);
              }
            }
            createdTasks.push(task);
          }

          if (!createdTasks.length) {
            return { success: false, summary: 'Thiếu tiêu đề công việc', error: 'Missing task title' };
          }
          db.save();
          return {
            success: true,
            summary: createdTasks.length === 1
              ? `Đã tạo task "${createdTasks[0].title}"`
              : `Đã tạo ${createdTasks.length} công việc mới`,
            data: createdTasks.length === 1 ? createdTasks[0] : createdTasks,
          };
        }

        case 'update_erp_task': {
          const taskId = String(args.taskId || '').trim();
          if (!taskId) return { success: false, summary: 'Thiếu taskId', error: 'Missing taskId' };
          const taskSvc = ErpTaskService.getInstance();

          const patch: Record<string, any> = {};
          if (args.title !== undefined) patch.title = String(args.title);
          if (args.description !== undefined) patch.description = String(args.description);
          if (args.projectId !== undefined) patch.project_id = args.projectId;
          if (args.status !== undefined) {
            if (!['todo', 'doing', 'review', 'done'].includes(args.status)) {
              return { success: false, summary: 'Trạng thái không hợp lệ (chỉ hỗ trợ todo, doing, review, done)', error: 'Invalid status' };
            }
            patch.status = args.status;
          }
          if (args.priority && ['low', 'normal', 'high', 'urgent'].includes(args.priority)) {
            patch.priority = args.priority;
          }
          if (args.startDateIso !== undefined) patch.start_date = parseIsoMs(args.startDateIso) ?? null;
          if (args.dueDateIso !== undefined) patch.due_date = parseIsoMs(args.dueDateIso) ?? null;
          if (args.estimatedHours !== undefined) patch.estimated_hours = Number(args.estimatedHours);
          if (args.actualHours !== undefined) patch.actual_hours = Number(args.actualHours);

          if (Array.isArray(args.assigneeIds)) {
            const incoming = args.assigneeIds.map((id: any) => resolveEmployeeId(db, String(id))).filter(Boolean);
            if (args.assigneeMode === 'replace') {
              patch.assignees = incoming;
            } else {
              const existing = taskSvc.getTaskAssignees(taskId);
              patch.assignees = Array.from(new Set([...existing, ...incoming]));
            }
          }

          const updated = taskSvc.updateTask(taskId, patch, 'boss');
          if (args.dependsOnTaskId) {
            taskSvc.addDependency(taskId, String(args.dependsOnTaskId), 'FS');
          }
          db.save();
          return { success: true, summary: `Đã cập nhật task "${updated.title}"`, data: updated };
        }

        case 'manage_task_checklist_and_comments': {
          const taskId = String(args.taskId || '').trim();
          if (!taskId) return { success: false, summary: 'Thiếu taskId', error: 'Missing taskId' };
          const taskSvc = ErpTaskService.getInstance();
          let addedCount = 0;
          let toggledCount = 0;
          let commented = false;

          if (Array.isArray(args.addChecklistItems)) {
            for (const text of args.addChecklistItems) {
              const clean = String(text || '').trim();
              if (clean) {
                taskSvc.addChecklist(taskId, clean);
                addedCount++;
              }
            }
          }
          if (Array.isArray(args.toggleChecklistItems)) {
            for (const item of args.toggleChecklistItems) {
              if (item && Number.isFinite(Number(item.checklistId))) {
                taskSvc.toggleChecklist(Number(item.checklistId), !!item.done);
                toggledCount++;
              }
            }
          }
          if (args.commentContent && String(args.commentContent).trim()) {
            const content = String(args.commentContent).trim();
            if (args.commentId && Number.isFinite(Number(args.commentId))) {
              taskSvc.editComment(Number(args.commentId), content);
            } else {
              taskSvc.addComment(taskId, 'boss', content);
            }
            commented = true;
          }
          db.save();
          return {
            success: true,
            summary: [
              addedCount ? `+${addedCount} checklist` : '',
              toggledCount ? `cập nhật ${toggledCount} checklist` : '',
              commented ? 'đã lưu bình luận' : '',
            ].filter(Boolean).join(', ') || 'Đã cập nhật công việc',
          };
        }

        case 'create_erp_event': {
          const title = String(args.title || '').trim();
          const startAt = parseIsoMs(args.startAtIso);
          if (!title || !startAt) return { success: false, summary: 'Thiếu tiêu đề hoặc thời gian bắt đầu hợp lệ', error: 'Invalid event params' };
          const endAt = parseIsoMs(args.endAtIso) || (startAt + 3600_000);
          const validTypes = ['meeting', 'appointment', 'reminder', 'task', 'leave'];
          const evType = validTypes.includes(args.type) ? args.type : 'meeting';
          const mins = Number.isFinite(Number(args.reminderMinutes)) ? Math.max(0, Number(args.reminderMinutes)) : 15;
          const attendees = Array.isArray(args.attendeeIds)
            ? args.attendeeIds.map((id: any) => resolveEmployeeId(db, String(id))).filter(Boolean)
            : undefined;
          const event = ErpCalendarService.getInstance().createEvent({
            title,
            description: args.description ? String(args.description) : '',
            type: evType,
            start_at: startAt,
            end_at: endAt,
            all_day: args.allDay ? 1 : 0,
            location: args.location ? String(args.location) : '',
            attendees,
            linked_task_id: args.linkedTaskId ? String(args.linkedTaskId) : undefined,
            linked_contact_id: args.linkedContactId ? String(args.linkedContactId) : undefined,
            reminders: [{ minutes_before: mins, channel: 'toast' }],
          }, 'boss');
          db.save();
          return { success: true, summary: `Đã tạo lịch "${event.title}"`, data: event };
        }

        case 'update_erp_event': {
          const eventId = String(args.eventId || '').trim();
          if (!eventId) return { success: false, summary: 'Thiếu eventId', error: 'Missing eventId' };
          const patch: Record<string, any> = {};
          if (args.title !== undefined) patch.title = String(args.title);
          if (args.description !== undefined) patch.description = String(args.description);
          if (args.location !== undefined) patch.location = String(args.location);
          if (args.type && ['meeting', 'appointment', 'reminder', 'task'].includes(args.type)) patch.type = args.type;
          if (args.startAtIso) {
            const s = parseIsoMs(args.startAtIso);
            if (s) patch.start_at = s;
          }
          if (args.endAtIso) {
            const e = parseIsoMs(args.endAtIso);
            if (e) patch.end_at = e;
          }
          if (args.reminderMinutes !== undefined && Number.isFinite(Number(args.reminderMinutes))) {
            patch.reminders = [{ minutes_before: Math.max(0, Number(args.reminderMinutes)), channel: 'toast' }];
          }
          const updated = ErpCalendarService.getInstance().updateEvent(eventId, patch);
          db.save();
          return { success: true, summary: `Đã cập nhật lịch "${updated.title}"`, data: updated };
        }

        case 'create_erp_note': {
          const title = String(args.title || '').trim();
          const content = String(args.content || '').trim();
          if (!title) return { success: false, summary: 'Thiếu tiêu đề ghi chú', error: 'Missing title' };
          const noteSvc = ErpNoteService.getInstance();
          let folderId = args.folderId != null ? Number(args.folderId) : undefined;
          if (folderId === undefined && args.folderName) {
            const fName = String(args.folderName).trim();
            const existing = noteSvc.listFolders('boss').find(f => f.name.trim().toLowerCase() === fName.toLowerCase());
            folderId = existing ? existing.id : noteSvc.createFolder(fName, 'boss').id;
          }
          const note = noteSvc.createNote({ title, content, folder_id: folderId }, 'boss');
          db.save();
          return { success: true, summary: `Đã lưu ghi chú "${note.title}"`, data: note };
        }

        case 'update_erp_note': {
          const noteSvc = ErpNoteService.getInstance();
          if (args.createFolderName) {
            const folder = noteSvc.createFolder(String(args.createFolderName).trim(), 'boss');
            db.save();
            return { success: true, summary: `Đã tạo thư mục "${folder.name}"`, data: folder };
          }
          if (args.renameFolderId && args.newFolderName) {
            noteSvc.renameFolder(Number(args.renameFolderId), String(args.newFolderName).trim());
            db.save();
            return { success: true, summary: `Đã đổi tên thư mục thành "${args.newFolderName}"` };
          }
          const noteId = String(args.noteId || '').trim();
          if (!noteId) return { success: false, summary: 'Thiếu noteId hoặc tên thư mục', error: 'Missing noteId' };
          const patch: Record<string, any> = {};
          if (args.title !== undefined) patch.title = String(args.title);
          if (args.content !== undefined) patch.content = String(args.content);
          if (args.folderId !== undefined) patch.folder_id = args.folderId;
          if (args.pinned !== undefined) patch.pinned = args.pinned ? 1 : 0;
          const updated = noteSvc.updateNote(noteId, patch, 'boss');
          db.save();
          return { success: true, summary: `Đã cập nhật ghi chú "${updated.title}"`, data: updated };
        }

        case 'update_crm_contact': {
          const accountId = String(args.accountId || '').trim();
          const contactId = String(args.contactId || '').trim();
          if (!accountId || !contactId) {
            return { success: false, summary: 'Thiếu accountId hoặc contactId', error: 'Invalid contact params' };
          }
          if (args.alias !== undefined) {
            db.setContactAlias(accountId, contactId, String(args.alias));
          }
          const setClauses: string[] = [];
          const vals: any[] = [];
          if (args.phone !== undefined) { setClauses.push('phone = ?'); vals.push(String(args.phone)); }
          if (args.gender !== undefined) {
            const gVal = args.gender === 'male' ? 0 : args.gender === 'female' ? 1 : null;
            setClauses.push('gender = ?');
            vals.push(gVal);
          }
          if (args.birthday !== undefined) { setClauses.push('birthday = ?'); vals.push(String(args.birthday)); }
          if (setClauses.length) {
            vals.push(accountId, contactId);
            db.run(`UPDATE contacts SET ${setClauses.join(', ')} WHERE owner_zalo_id = ? AND contact_id = ?`, vals);
          }
          db.save();
          EventBroadcaster.emit('db:contactUpdated', { ownerZaloId: accountId, contactId });
          return { success: true, summary: `Đã cập nhật thông tin CRM cho ${args.contactName || contactId}` };
        }

        case 'add_crm_note': {
          const accountId = String(args.accountId || '').trim();
          const contactId = String(args.contactId || '').trim();
          const content = String(args.content || '').trim();
          if (!accountId || !contactId || !content) {
            return { success: false, summary: 'Thiếu accountId, contactId hoặc nội dung ghi chú', error: 'Invalid CRM note params' };
          }
          const id = db.saveCRMNote({
            id: args.noteId ? Number(args.noteId) : undefined,
            owner_zalo_id: accountId,
            contact_id: contactId,
            contact_type: 'user',
            content,
          });
          if (!id) return { success: false, summary: 'Không thể lưu ghi chú CRM', error: 'DB insert failed' };
          db.save();
          EventBroadcaster.emit('crm:noteChanged', {
            action: 'save',
            ownerZaloId: accountId,
            id,
            note: { id, owner_zalo_id: accountId, contact_id: contactId, content },
          });
          return { success: true, summary: `Đã lưu ghi chú CRM cho ${args.contactName || contactId}`, data: { id } };
        }

        case 'manage_crm_tag_or_label': {
          const targetType = args.targetType === 'crm_tag' ? 'crm_tag' : 'local_label';
          const name = String(args.name || '').trim();
          if (!name) return { success: false, summary: 'Thiếu tên nhãn/tag', error: 'Missing label name' };
          const color = String(args.color || '#3B82F6');
          const emoji = String(args.emoji || '🏷️');
          const accountId = String(args.accountId || db.getAccounts()[0]?.zalo_id || '').trim();
          const contactIds: string[] = Array.isArray(args.assignContactIds)
            ? args.assignContactIds.map((x: any) => String(x || '').trim()).filter(Boolean)
            : [];

          if (targetType === 'crm_tag') {
            if (!accountId) return { success: false, summary: 'Thiếu accountId cho Tag CRM', error: 'Missing accountId' };
            let tagId = args.id ? Number(args.id) : undefined;
            if (tagId) {
              db.run(`UPDATE crm_tags SET name = ?, color = ?, emoji = ? WHERE id = ?`, [name, color, emoji, tagId]);
            } else {
              const existing = db.queryOne<any>(
                `SELECT id FROM crm_tags WHERE owner_zalo_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
                [accountId, name]
              );
              if (existing) {
                tagId = Number(existing.id);
              } else {
                tagId = db.runInsert(
                  `INSERT INTO crm_tags (owner_zalo_id, name, color, emoji, created_at) VALUES (?,?,?,?,?)`,
                  [accountId, name, color, emoji, Date.now()]
                );
              }
            }
            for (const cid of contactIds) {
              db.run(
                `INSERT OR IGNORE INTO crm_contact_tags (owner_zalo_id, contact_id, tag_id) VALUES (?,?,?)`,
                [accountId, cid, tagId]
              );
            }
            db.save();
            return {
              success: true,
              summary: `Đã lưu Tag CRM "${name}"${contactIds.length ? ` và gắn cho ${contactIds.length} khách hàng` : ''}`,
              data: { tagId },
            };
          } else {
            const labels = db.getLocalLabels(accountId || undefined);
            const matched = args.id
              ? labels.find((l: any) => l.id === Number(args.id))
              : labels.find((l: any) => String(l.name || '').trim().toLowerCase() === name.toLowerCase());
            const labelId = db.upsertLocalLabel({
              id: matched?.id,
              name,
              color,
              emoji,
              pageIds: matched?.page_ids ?? '',
            });
            if (!labelId || labelId < 0) {
              return { success: false, summary: 'Không lưu được nhãn Deplao', error: 'upsertLocalLabel failed' };
            }
            if (accountId && contactIds.length) {
              for (const cid of contactIds) {
                db.assignLocalLabelToThread(accountId, labelId, cid);
                EventBroadcaster.emit('db:localLabelThreadChanged', {
                  action: 'assign',
                  ownerZaloId: accountId,
                  labelId,
                  threadId: cid,
                });
              }
            }
            db.save();
            return {
              success: true,
              summary: `Đã lưu nhãn Deplao "${name}"${contactIds.length ? ` và gắn cho ${contactIds.length} hội thoại` : ''}`,
              data: { labelId },
            };
          }
        }

        case 'save_crm_campaign': {
          const accountId = String(args.accountId || '').trim();
          const name = String(args.name || '').trim();
          if (!accountId || !name) {
            return { success: false, summary: 'Thiếu accountId hoặc tên chiến dịch', error: 'Invalid campaign params' };
          }
          const campaignId = args.campaignId ? Number(args.campaignId) : undefined;
          const existing = campaignId ? db.getCRMCampaign(campaignId) : null;
          const safeStatus = args.status === 'paused' ? 'paused' : 'draft';
          const allowedTypes = ['message', 'friend_request', 'mixed', 'invite_to_group'] as const;
          const rawType = String(args.campaignType || existing?.campaign_type || 'message');
          const campaignType = (allowedTypes as readonly string[]).includes(rawType)
            ? (rawType as typeof allowedTypes[number])
            : 'message';
          const delayMin = args.delayMinSeconds != null ? Number(args.delayMinSeconds) : (existing?.delay_min_seconds ?? 50);
          const delayMax = args.delayMaxSeconds != null ? Number(args.delayMaxSeconds) : (existing?.delay_max_seconds ?? Math.max(delayMin, 70));
          const delayMid = Math.max(1, Math.round((delayMin + delayMax) / 2));

          const id = db.saveCRMCampaign({
            id: campaignId,
            owner_zalo_id: accountId,
            name,
            template_message: args.templateMessage !== undefined
              ? String(args.templateMessage)
              : (existing?.template_message || ''),
            friend_request_message: args.friendRequestMessage !== undefined
              ? String(args.friendRequestMessage)
              : (existing?.friend_request_message || ''),
            campaign_type: campaignType,
            status: safeStatus,
            delay_seconds: delayMid,
            daily_send_limit: args.dailySendLimit != null ? Number(args.dailySendLimit) : existing?.daily_send_limit,
            delay_min_seconds: delayMin,
            delay_max_seconds: delayMax,
          });
          if (!id) return { success: false, summary: 'Không lưu được chiến dịch CRM', error: 'saveCRMCampaign failed' };

          let addedContacts = 0;
          if (Array.isArray(args.addContacts) && args.addContacts.length > 0) {
            const list = args.addContacts
              .filter((c: any) => c?.contactId)
              .map((c: any) => ({
                contact_id: String(c.contactId),
                display_name: String(c.displayName || c.contactId),
              }));
            if (list.length) {
              db.addCampaignContacts(id, accountId, list);
              addedContacts = list.length;
            }
          }
          db.save();
          EventBroadcaster.emit('crm:campaignChanged', { action: 'save', ownerZaloId: accountId, id });
          return {
            success: true,
            summary: `Đã lưu chiến dịch CRM "${name}" (${safeStatus})${addedContacts ? ` với ${addedContacts} khách hàng` : ''}`,
            data: { id },
          };
        }

        case 'assign_conversation_label': {
          const accountId = String(args.accountId || '').trim();
          const threadId = String(args.threadId || '').trim();
          const labelName = String(args.labelName || '').trim();
          if (!accountId || !threadId || !labelName) {
            return { success: false, summary: 'Thiếu thông tin hội thoại hoặc tên nhãn', error: 'Invalid label params' };
          }
          const labels = db.getLocalLabels(accountId);
          const match = labels.find((l: any) => String(l.name || '').toLowerCase() === labelName.toLowerCase());
          let labelId = match?.id;
          if (!labelId) {
            labelId = db.upsertLocalLabel({
              name: labelName,
              color: '#3B82F6',
              emoji: '🏷️',
              pageIds: '',
            });
          }
          if (!labelId || labelId < 0) {
            return { success: false, summary: 'Không tạo được nhãn mới', error: 'upsertLocalLabel failed' };
          }
          db.assignLocalLabelToThread(accountId, labelId, threadId);
          db.save();
          EventBroadcaster.emit('db:localLabelThreadChanged', {
            action: 'assign',
            ownerZaloId: accountId,
            labelId,
            threadId,
          });
          return { success: true, summary: `Đã gắn nhãn "${labelName}" cho ${args.threadName || threadId}`, data: { labelId } };
        }

        default:
          return { success: false, summary: `Hành động không hỗ trợ phía backend: ${toolName}`, error: 'Unsupported write tool' };
      }
    } catch (err: any) {
      Logger.error(`[AIToolService] executeWriteTool(${toolName}) failed: ${err?.message || err}`);
      return { success: false, summary: err?.message || String(err), error: err?.message || String(err) };
    }
  }
}

export default AIToolService;
