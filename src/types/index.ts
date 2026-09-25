export interface Project {
  id: string;
  name: string;
  status: "active" | "inactive" | "pending";
  created_at: string;
  updated_at: string;
}

export interface Alarm {
  id: string;
  project_id: string;
  device_name: string;
  device_ip: string;
  alarm_type: "offline" | "online" | "warning";
  message: string;
  created_at: string;
  resolved_at: string | null;
  project?: Project;
}
