'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onSignOut() {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signout', { method: 'POST' });
      if (res.ok) {
        router.push('/login');
        router.refresh();
        return;
      }
    } catch {
      // fallthrough — botão volta a ficar activo
    }
    setLoading(false);
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onSignOut}
      disabled={loading}
    >
      {loading ? <Spinner /> : null}
      {loading ? 'A sair...' : 'Sair'}
    </Button>
  );
}
