"""Ephemeral project store used by the GitHub release.

The public release deliberately does not persist document history, uploaded
files, API keys, or SQLite databases. GIS projects are kept only for the
current server process so the existing project screen remains compatible.
"""

from datetime import datetime


_gis_projects = {}


def init_db():
    """保留相容介面，但不建立任何本機資料庫。"""
    return None


def get_all_pinned_filepaths():
    """歷史功能已移除，暫存檔清理不再依賴釘選資料。"""
    return set()


def save_gis_project(project_id, name, data_points, config):
    _gis_projects[project_id] = {
        "id": project_id,
        "name": name,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "is_pinned": 0,
        "data_points": data_points,
        "config": config,
    }
    return None


def get_gis_projects():
    return sorted(
        [
            {
                "id": project["id"],
                "name": project["name"],
                "timestamp": project["timestamp"],
                "is_pinned": project["is_pinned"],
            }
            for project in _gis_projects.values()
        ],
        key=lambda item: (item["is_pinned"], item["timestamp"]),
        reverse=True,
    )


def get_gis_project(project_id):
    return _gis_projects.get(project_id)


def delete_gis_project(project_id):
    _gis_projects.pop(project_id, None)
    return None


def toggle_gis_pin(project_id):
    if project_id in _gis_projects:
        _gis_projects[project_id]["is_pinned"] = 1 - int(
            _gis_projects[project_id].get("is_pinned", 0)
        )
    return None
