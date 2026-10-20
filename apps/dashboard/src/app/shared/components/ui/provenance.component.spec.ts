import { TestBed } from '@angular/core/testing';

import { ProvenanceComponent } from './provenance.component';

describe('ProvenanceComponent', () => {
  it('pinta el superíndice E en color estimado con texto para lectores de pantalla', async () => {
    const f = TestBed.createComponent(ProvenanceComponent);
    f.componentRef.setInput('p', 'estimated');
    await f.whenStable();
    const sup = (f.nativeElement as HTMLElement).querySelector('sup')!;
    expect(sup.textContent?.trim()).toBe('E');
    expect(sup.className).toContain('text-estimated');
    expect((f.nativeElement as HTMLElement).querySelector('.sr-only')?.textContent).toContain('estimado');
  });
  it('R y S en color apagado; nada si no hay procedencia', async () => {
    const f = TestBed.createComponent(ProvenanceComponent);
    f.componentRef.setInput('p', 'simulated');
    await f.whenStable();
    expect((f.nativeElement as HTMLElement).querySelector('sup')?.textContent?.trim()).toBe('S');
    f.componentRef.setInput('p', null);
    await f.whenStable();
    expect((f.nativeElement as HTMLElement).querySelector('sup')).toBeNull();
  });
});
