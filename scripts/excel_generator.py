#!/usr/bin/env python3
"""
生成带图表的 Excel 文件
使用 xlsxwriter 创建可编辑的 Excel 原生图表
"""

import sys
import json
import xlsxwriter
from io import BytesIO
import base64

def create_excel_with_chart(data_json: str, output_path: str = None) -> str:
    """
    创建带图表的 Excel 文件
    
    Args:
        data_json: JSON 字符串，包含数据和配置
        output_path: 输出文件路径，如果为 None 则返回 base64 编码
    
    Returns:
        如果 output_path 为 None，返回 base64 编码的文件内容
        否则返回文件路径
    """
    data = json.loads(data_json)
    
    # 创建内存缓冲区或文件
    if output_path:
        workbook = xlsxwriter.Workbook(output_path)
    else:
        output = BytesIO()
        workbook = xlsxwriter.Workbook(output, {'in_memory': True})
    
    # 格式定义
    header_format = workbook.add_format({
        'bold': True,
        'align': 'center',
        'valign': 'vcenter',
        'bg_color': '#4472C4',
        'font_color': 'white',
        'border': 1
    })
    
    cell_format = workbook.add_format({
        'align': 'center',
        'valign': 'vcenter',
        'border': 1
    })
    
    number_format = workbook.add_format({
        'num_format': '0.0000',
        'align': 'center',
        'border': 1
    })
    
    # ==================== 工作表1: 源数据 ====================
    source_sheet = workbook.add_worksheet('源数据')
    
    # 表头
    source_headers = ['序号', '电压(V)', '容量(Ah)']
    for col, header in enumerate(source_headers):
        source_sheet.write(0, col, header, header_format)
    
    # 数据
    voltage = data.get('voltage', [])
    capacity = data.get('capacity', [])
    for i, (v, c) in enumerate(zip(voltage, capacity)):
        source_sheet.write(i + 1, 0, i + 1, cell_format)
        source_sheet.write_number(i + 1, 1, v, number_format)
        source_sheet.write_number(i + 1, 2, c, number_format)
    
    # 设置列宽
    source_sheet.set_column('A:A', 8)
    source_sheet.set_column('B:C', 15)
    
    # ==================== 工作表2: 差分数据和图表 ====================
    chart_type = data.get('type', 'dqdv')
    dataset_name = data.get('name', '数据集')
    
    if chart_type == 'dqdv':
        diff_sheet = workbook.add_worksheet('dQ-dV数据')
        
        # 表头
        diff_headers = ['序号', '电压(V)', 'dQ/dV(Ah/V)']
        for col, header in enumerate(diff_headers):
            diff_sheet.write(0, col, header, header_format)
        
        # 数据
        diff_voltage = data.get('differential', {}).get('voltage', [])
        diff_dqdv = data.get('differential', {}).get('dqdv', [])
        
        for i, (v, d) in enumerate(zip(diff_voltage, diff_dqdv)):
            diff_sheet.write(i + 1, 0, i + 1, cell_format)
            diff_sheet.write_number(i + 1, 1, v, number_format)
            diff_sheet.write_number(i + 1, 2, d, number_format)
        
        diff_sheet.set_column('A:A', 8)
        diff_sheet.set_column('B:C', 15)
        
        # ==================== 工作表3: 峰信息 ====================
        peaks = data.get('peaks', {}).get('dqdv', [])
        if peaks:
            peaks_sheet = workbook.add_worksheet('峰信息')
            peaks_headers = ['峰编号', '电压(V)', '峰高(Ah/V)', '峰强', '区间起点(V)', 
                           '区间终点(V)', '峰宽(V)', '距起点(V)', '距下峰(V)']
            for col, header in enumerate(peaks_headers):
                peaks_sheet.write(0, col, header, header_format)
            
            for i, peak in enumerate(peaks):
                peaks_sheet.write(i + 1, 0, f'P{i + 1}', cell_format)
                peaks_sheet.write_number(i + 1, 1, peak.get('position', 0), number_format)
                peaks_sheet.write_number(i + 1, 2, peak.get('height', 0), number_format)
                peaks_sheet.write_number(i + 1, 3, peak.get('intensity', 0), number_format)
                if peak.get('intervalStart') is not None:
                    peaks_sheet.write_number(i + 1, 4, peak['intervalStart'], number_format)
                if peak.get('intervalEnd') is not None:
                    peaks_sheet.write_number(i + 1, 5, peak['intervalEnd'], number_format)
                if peak.get('width') is not None:
                    peaks_sheet.write_number(i + 1, 6, peak['width'], number_format)
                if peak.get('distanceFromStart') is not None:
                    peaks_sheet.write_number(i + 1, 7, peak['distanceFromStart'], number_format)
                if peak.get('distanceToNext') is not None:
                    peaks_sheet.write_number(i + 1, 8, peak['distanceToNext'], number_format)
        
        # ==================== 工作表4: 图表 ====================
        chart_sheet = workbook.add_worksheet('dQ-dV图表')
        
        # 写入图表数据
        chart_sheet.write(0, 0, '电压(V)', header_format)
        chart_sheet.write(0, 1, 'dQ/dV(Ah/V)', header_format)
        
        # 采样数据（最多2000个点）
        max_points = 2000
        step = max(1, len(diff_voltage) // max_points)
        
        sampled_voltage = diff_voltage[::step]
        sampled_dqdv = diff_dqdv[::step]
        
        for i, (v, d) in enumerate(zip(sampled_voltage, sampled_dqdv)):
            chart_sheet.write_number(i + 1, 0, v, number_format)
            chart_sheet.write_number(i + 1, 1, d, number_format)
        
        chart_sheet.set_column('A:B', 15)
        
        # 创建散点图
        chart = workbook.add_chart({'type': 'scatter', 'subtype': 'smooth'})
        
        chart.set_title({'name': f'{dataset_name} - dQ/dV曲线'})
        chart.set_x_axis({
            'name': '电压 (V)',
            'name_font': {'size': 11, 'bold': True},
            'num_font': {'size': 10}
        })
        chart.set_y_axis({
            'name': 'dQ/dV (Ah/V)',
            'name_font': {'size': 11, 'bold': True},
            'num_font': {'size': 10}
        })
        
        # 添加数据系列
        data_end_row = len(sampled_voltage)
        chart.add_series({
            'name': 'dQ/dV',
            'categories': f"='dQ-dV图表'!$A$2:$A${data_end_row + 1}",
            'values': f"='dQ-dV图表'!$B$2:$B${data_end_row + 1}",
            'line': {'color': '#3b82f6', 'width': 1.5},
            'marker': {'type': 'none'}
        })
        
        # 设置图表大小和位置
        chart.set_size({'width': 600, 'height': 400})
        chart_sheet.insert_chart('D2', chart)
        
    else:  # dvdq
        diff_sheet = workbook.add_worksheet('dV-dQ数据')
        
        # 表头
        diff_headers = ['序号', '容量(Ah)', 'dV/dQ(V/Ah)']
        for col, header in enumerate(diff_headers):
            diff_sheet.write(0, col, header, header_format)
        
        # 数据
        diff_capacity = data.get('differential', {}).get('capacity', [])
        diff_dvdq = data.get('differential', {}).get('dvdq', [])
        
        for i, (c, d) in enumerate(zip(diff_capacity, diff_dvdq)):
            diff_sheet.write(i + 1, 0, i + 1, cell_format)
            diff_sheet.write_number(i + 1, 1, c, number_format)
            diff_sheet.write_number(i + 1, 2, d, number_format)
        
        diff_sheet.set_column('A:A', 8)
        diff_sheet.set_column('B:C', 15)
        
        # ==================== 工作表3: 峰信息 ====================
        peaks = data.get('peaks', {}).get('dvdq', [])
        if peaks:
            peaks_sheet = workbook.add_worksheet('峰信息')
            peaks_headers = ['峰编号', '容量(Ah)', '峰高(V/Ah)', '峰强', '区间起点(Ah)', 
                           '区间终点(Ah)', '峰宽(Ah)', '距起点(Ah)', '距下峰(Ah)']
            for col, header in enumerate(peaks_headers):
                peaks_sheet.write(0, col, header, header_format)
            
            for i, peak in enumerate(peaks):
                peaks_sheet.write(i + 1, 0, f'P{i + 1}', cell_format)
                peaks_sheet.write_number(i + 1, 1, peak.get('position', 0), number_format)
                peaks_sheet.write_number(i + 1, 2, peak.get('height', 0), number_format)
                peaks_sheet.write_number(i + 1, 3, peak.get('intensity', 0), number_format)
                if peak.get('intervalStart') is not None:
                    peaks_sheet.write_number(i + 1, 4, peak['intervalStart'], number_format)
                if peak.get('intervalEnd') is not None:
                    peaks_sheet.write_number(i + 1, 5, peak['intervalEnd'], number_format)
                if peak.get('width') is not None:
                    peaks_sheet.write_number(i + 1, 6, peak['width'], number_format)
                if peak.get('distanceFromStart') is not None:
                    peaks_sheet.write_number(i + 1, 7, peak['distanceFromStart'], number_format)
                if peak.get('distanceToNext') is not None:
                    peaks_sheet.write_number(i + 1, 8, peak['distanceToNext'], number_format)
        
        # ==================== 工作表4: 图表 ====================
        chart_sheet = workbook.add_worksheet('dV-dQ图表')
        
        # 写入图表数据
        chart_sheet.write(0, 0, '容量(Ah)', header_format)
        chart_sheet.write(0, 1, 'dV/dQ(V/Ah)', header_format)
        
        # 采样数据
        max_points = 2000
        step = max(1, len(diff_capacity) // max_points)
        
        sampled_capacity = diff_capacity[::step]
        sampled_dvdq = diff_dvdq[::step]
        
        for i, (c, d) in enumerate(zip(sampled_capacity, sampled_dvdq)):
            chart_sheet.write_number(i + 1, 0, c, number_format)
            chart_sheet.write_number(i + 1, 1, d, number_format)
        
        chart_sheet.set_column('A:B', 15)
        
        # 创建散点图
        chart = workbook.add_chart({'type': 'scatter', 'subtype': 'smooth'})
        
        chart.set_title({'name': f'{dataset_name} - dV/dQ曲线'})
        chart.set_x_axis({
            'name': '容量 (Ah)',
            'name_font': {'size': 11, 'bold': True},
            'num_font': {'size': 10}
        })
        chart.set_y_axis({
            'name': 'dV/dQ (V/Ah)',
            'name_font': {'size': 11, 'bold': True},
            'num_font': {'size': 10}
        })
        
        # 添加数据系列
        data_end_row = len(sampled_capacity)
        chart.add_series({
            'name': 'dV/dQ',
            'categories': f"='dV-dQ图表'!$A$2:$A${data_end_row + 1}",
            'values': f"='dV-dQ图表'!$B$2:$B${data_end_row + 1}",
            'line': {'color': '#a855f7', 'width': 1.5},
            'marker': {'type': 'none'}
        })
        
        chart.set_size({'width': 600, 'height': 400})
        chart_sheet.insert_chart('D2', chart)
    
    workbook.close()
    
    if output_path:
        return output_path
    else:
        output.seek(0)
        return base64.b64encode(output.getvalue()).decode('utf-8')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python excel_generator.py <json_data> [output_path]")
        sys.exit(1)
    
    json_data = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    
    result = create_excel_with_chart(json_data, output_path)
    print(result)
