import './Skeleton.css';

export function Skeleton({ width, height, radius, className, style }: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={'sk' + (className ? ' ' + className : '')}
      style={{
        width: typeof width === 'number' ? width + 'px' : width,
        height: typeof height === 'number' ? height + 'px' : height,
        borderRadius: typeof radius === 'number' ? radius + 'px' : radius,
        ...style,
      }}
    />
  );
}

/** 預設專案卡 skeleton（admin / studio / preview picker 共用） */
export function ProjectCardSkeleton() {
  return (
    <div className="sk-card">
      <Skeleton height={20} width="70%" radius={4} />
      <Skeleton height={14} width="90%" radius={3} />
      <Skeleton height={14} width="50%" radius={3} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Skeleton height={20} width={60} radius={999} />
        <Skeleton height={20} width={40} radius={999} />
      </div>
    </div>
  );
}

/** 留言 skeleton */
export function CommentSkeleton() {
  return (
    <div className="sk-comment">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Skeleton height={12} width={50} radius={3} />
        <Skeleton height={10} width={30} radius={3} />
      </div>
      <Skeleton height={12} width="92%" radius={3} style={{ marginTop: 6 }} />
      <Skeleton height={12} width="60%" radius={3} style={{ marginTop: 4 }} />
    </div>
  );
}

/** 列表 row skeleton */
export function RowSkeleton() {
  return (
    <div className="sk-row">
      <Skeleton height={14} width="40%" radius={3} />
      <Skeleton height={14} width="20%" radius={3} />
    </div>
  );
}
