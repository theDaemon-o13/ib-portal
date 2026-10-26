import type { NavItem } from '../../nav';

export function StubPage({ item }: { item: NavItem }) {
  return (
    <>
      <div className="head">
        <div>
          <h1>{item.title}</h1>
        </div>
      </div>
      <section className="panel">
        <div className="stub">
          <h2>Раздел в разработке</h2>
          <p>Он появится в одном из следующих выпусков портала.</p>
        </div>
      </section>
    </>
  );
}
