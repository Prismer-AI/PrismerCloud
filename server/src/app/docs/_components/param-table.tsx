'use client';

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description: string;
  default?: unknown;
  enum?: string[];
}

interface ParamTableProps {
  params: Parameter[];
  title: string;
  isDark: boolean;
  showNesting?: boolean;
}

export type { Parameter };

export function ParamTable({ params, title, isDark, showNesting = false }: ParamTableProps) {
  return (
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-zinc-500">{title}</h4>
      <div
        className={`rounded-xl overflow-hidden ${isDark ? 'bg-zinc-950 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}
      >
        <table className="w-full text-xs">
          <thead className={isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}>
            <tr>
              <th className={`text-left px-3 py-2 font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Field</th>
              <th className={`text-left px-3 py-2 font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Type</th>
              <th className={`text-left px-3 py-2 font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Req</th>
              <th className={`text-left px-3 py-2 font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                Default
              </th>
              <th className={`text-left px-3 py-2 font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                Description
              </th>
            </tr>
          </thead>
          <tbody className={`divide-y ${isDark ? 'divide-white/5' : 'divide-zinc-200'}`}>
            {params.map((param, i) => {
              const nestDepth = showNesting ? param.name.split('.').length - 1 : 0;
              const displayName = showNesting && nestDepth > 0 ? param.name.split('.').pop()! : param.name;
              return (
                <tr key={i}>
                  <td className={`px-3 py-2 font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                    {nestDepth > 0 && (
                      <span className="text-zinc-600" style={{ paddingLeft: `${(nestDepth - 1) * 12}px` }}>
                        {'└ '}
                      </span>
                    )}
                    {displayName}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono whitespace-nowrap ${isDark ? 'text-violet-400' : 'text-violet-700'}`}
                  >
                    {param.type}
                    {param.enum ? <span className="text-zinc-500 font-normal"> ({param.enum.join(' | ')})</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    {param.required ? (
                      <span className={`font-medium ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>Y</span>
                    ) : (
                      <span className="text-zinc-500">N</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-500">
                    {param.default !== undefined ? String(param.default) : '—'}
                  </td>
                  <td className={`px-3 py-2 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{param.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
