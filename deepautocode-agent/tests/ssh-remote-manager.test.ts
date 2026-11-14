import { describe, expect, it } from 'vitest';
import { SshRemoteManager } from '../src/core/SshRemoteManager.js';

describe('SshRemoteManager', () => {
  const ssh = SshRemoteManager.getInstance();

  it('parses basic host string', () => {
    const target = ssh.parseTarget('devbox.example.com');
    expect(target.host).toBe('devbox.example.com');
    expect(target.user).toBeUndefined();
    expect(target.port).toBeUndefined();
  });

  it('parses user@host format', () => {
    const target = ssh.parseTarget('ubuntu@192.168.1.100');
    expect(target.host).toBe('192.168.1.100');
    expect(target.user).toBe('ubuntu');
    expect(target.port).toBeUndefined();
  });

  it('parses user@host:port format', () => {
    const target = ssh.parseTarget('developer@cluster.corp:2222');
    expect(target.host).toBe('cluster.corp');
    expect(target.user).toBe('developer');
    expect(target.port).toBe(2222);
  });

  it('parses complex ssh command with -i and -p options', () => {
    const target = ssh.parseTarget('ssh -i ~/.ssh/cloud_key -p 2200 ec2-user@ec2.aws.com');
    expect(target.host).toBe('ec2.aws.com');
    expect(target.user).toBe('ec2-user');
    expect(target.port).toBe(2200);
    expect(target.identityFile).toBe('~/.ssh/cloud_key');
  });

  it('builds hardened SSH argument array', () => {
    const target = ssh.parseTarget('admin@srv.net -p 8022');
    const args = ssh.buildSshArgs(target, 'uname -a');

    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('-p');
    expect(args).toContain('8022');
    expect(args).toContain('admin@srv.net');
    expect(args).toContain('uname -a');
  });

  it('throws on empty or invalid SSH target', () => {
    expect(() => ssh.parseTarget('')).toThrow(/empty/i);
  });
});

